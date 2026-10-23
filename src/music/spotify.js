'use strict';
// Spotify is used to FIND songs, not to play them: Spotify audio is DRM-protected and no bot can
// stream it. Spotify gives the exact artist, title and length of what someone asked for (or of a
// Spotify link they pasted); the audio then comes from SoundCloud (music/resolve.js), and Spotify's
// length is used to reject SoundCloud previews, edits and wrong songs.
//
// Needs SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET (developer.spotify.com, client-credentials flow).
// Without them, track links still work through the public page title, and text search uses SoundCloud.
const { config } = require('../config');
const log = require('../log').logger('spotify');

let token = null; // { value, expiresAt }

function configured() {
  return Boolean(config.spotifyClientId && config.spotifyClientSecret);
}

async function getToken() {
  if (token && Date.now() < token.expiresAt - 60000) return token.value;
  const basic = Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });
  log.info(`token request -> ${res.status}`);
  if (!res.ok) throw new Error(`Spotify login failed (${res.status}): check SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET`);
  const data = await res.json();
  token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return token.value;
}

async function api(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      headers: { Authorization: `Bearer ${await getToken()}` },
      signal: AbortSignal.timeout(15000),
    });
    log.info(`GET ${path} -> ${res.status} in ${Date.now() - t0}ms`);
    if (res.status === 401 && attempt === 0) {
      token = null;
      continue;
    }
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(10, Number(res.headers.get('retry-after')) || 2);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      const err = new Error(`Spotify ${path.split('?')[0]} -> ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
  throw new Error('Spotify request failed');
}

/** Spotify track object -> what Fig needs. */
function toMeta(t) {
  if (!t || !t.name) return null;
  const artists = (t.artists || []).map((a) => a.name).filter(Boolean);
  return {
    spotifyId: t.id,
    title: t.name,
    artist: artists[0] || '',
    artists,
    durationSec: Math.round((Number(t.duration_ms) || 0) / 1000),
    url: t.external_urls?.spotify || (t.id ? `https://open.spotify.com/track/${t.id}` : ''),
    asked: artists.length ? `${artists[0]} - ${t.name}` : t.name,
  };
}

/** Text search. Returns up to `limit` (max 10, Spotify's dev-mode limit) metas, best first. */
async function searchTracks(query, { limit = 5 } = {}) {
  if (!configured()) return [];
  const q = encodeURIComponent(String(query).slice(0, 200));
  const data = await api(`/search?type=track&limit=${Math.min(10, Math.max(1, limit))}&q=${q}`);
  return (data?.tracks?.items || []).map(toMeta).filter(Boolean);
}

/** open.spotify.com/track|album|playlist/<id> or spotify:track:<id> */
function parseLink(text) {
  const s = String(text || '').trim();
  const m = s.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/i) || s.match(/^spotify:(track|album|playlist):([A-Za-z0-9]+)$/i);
  return m ? { kind: m[1].toLowerCase(), id: m[2] } : null;
}

/** Public page title, for when there are no API credentials: "Song - song and lyrics by Artist | Spotify". */
async function metaFromPage(kind, id) {
  const res = await fetch(`https://open.spotify.com/${kind}/${id}`, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Spotify page ${res.status}`);
  const html = await res.text();
  const og = (html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1];
  const desc = (html.match(/<meta property="og:description" content="([^"]+)"/) || [])[1] || '';
  const title = (html.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
  const decode = (x) => String(x || '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
  const name = decode(og || title.split(' - song')[0]);
  // og:description for a track is "Artist · Album · Song · 2013"
  const artist = decode(desc.split(' · ')[0] || (title.match(/by (.+?) \| Spotify/) || [])[1] || '');
  if (!name) throw new Error('could not read the Spotify page');
  return { spotifyId: id, title: name, artist, artists: artist ? [artist] : [], durationSec: 0, url: `https://open.spotify.com/${kind}/${id}`, asked: artist ? `${artist} - ${name}` : name };
}

// ---- Spotify's public embed page -------------------------------------------------------------------
// The page behind Spotify's "embed" widget (open.spotify.com/embed/playlist/<id>) lists the songs of any
// public playlist or album, with artist and length, without logging in. Since Feb 2026 the official API
// only returns the songs of playlists the app's own account owns, so this is how playlists from anyone
// else work. It is not an official API: Spotify can change the page, and it shows at most 100 songs.
// The data sits in one of three <script> tags (see spotify-url-info, which parses the same page).
const EMBED_LIMIT = 100;

function embedEntity(html) {
  const tag = (id) => (String(html).match(new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)</script>`)) || [])[1];
  const b64 = (s) => JSON.parse(Buffer.from(String(s).trim(), 'base64').toString('utf8'));
  const tries = [
    () => tag('__NEXT_DATA__') && JSON.parse(tag('__NEXT_DATA__')).props?.pageProps?.state?.data?.entity,
    () => tag('resource') && b64(tag('resource')),
    () => tag('initial-state') && b64(tag('initial-state')).data?.entity,
  ];
  for (const t of tries) {
    try {
      const e = t();
      if (e && (e.trackList || e.name || e.title)) return e;
    } catch {
      /* try the next format */
    }
  }
  return null;
}

/** One embed-page song (or the page's own entity, for a single track) -> what Fig needs. */
function embedToMeta(t) {
  const title = String(t?.title || t?.name || '').trim();
  if (!title) return null;
  const id = (String(t.uri || '').match(/^spotify:track:([A-Za-z0-9]+)$/) || [])[1] || null;
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  let artists = (t.artists || []).map((a) => clean(a?.name || a)).filter(Boolean);
  if (!artists.length) artists = clean(t.subtitle).split(/,\s*/).filter(Boolean); // "Artist, Other Artist"
  const ms = Number(t.duration ?? t.duration_ms) || 0;
  return {
    spotifyId: id,
    title,
    artist: artists[0] || '',
    artists,
    durationSec: Math.round(ms / 1000),
    url: id ? `https://open.spotify.com/track/${id}` : '',
    asked: artists.length ? `${artists[0]} - ${title}` : title,
    fromEmbed: true,
  };
}

/** Songs of a public playlist or album (or one track) from the embed page. */
async function fromEmbed(kind, id) {
  const res = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en' } });
  log.info(`GET embed/${kind}/${id} -> ${res.status}`);
  if (res.status === 404) throw new Error(`that Spotify ${kind} doesn't exist or is private`);
  if (!res.ok) throw new Error(`Spotify's public ${kind} page answered ${res.status}`);
  const entity = embedEntity(await res.text());
  if (!entity) throw new Error(`couldn't read Spotify's public ${kind} page (Spotify may have changed it)`);
  const metas = (entity.trackList ? entity.trackList : [entity]).map(embedToMeta).filter(Boolean);
  if (!metas.length) throw new Error(`that Spotify ${kind} has no songs I can see`);
  if (entity.trackList && entity.trackList.length >= EMBED_LIMIT) metas.capped = EMBED_LIMIT;
  log.info(`embed/${kind}/${id}: ${metas.length} song(s) from the public page${metas.capped ? ' (Spotify shows at most 100)' : ''}`);
  return metas;
}

/**
 * Expand a Spotify link into songs.
 *   track:    API, or without keys the public embed page (has the length), then the page title
 *   album:    API, or the public embed page
 *   playlist: API (works only for playlists the app's own account owns), else the public embed page
 * @returns {Promise<object[]>} metas (an array; `.capped` is set when Spotify cut the list at 100)
 */
async function fromLink(link) {
  const { kind, id } = link;
  if (kind === 'track') {
    if (configured()) return [toMeta(await api(`/tracks/${id}`))].filter(Boolean);
    try {
      return await fromEmbed('track', id);
    } catch (e) {
      log.warn(`track ${id} embed: ${e.message}; using the page title`);
      return [await metaFromPage('track', id)];
    }
  }
  if (configured()) {
    try {
      if (kind === 'album') {
        const album = await api(`/albums/${id}`);
        const items = album?.tracks?.items || [];
        const metas = items.slice(0, 50).map((t) => toMeta({ ...t, artists: t.artists?.length ? t.artists : album.artists })).filter(Boolean);
        if (metas.length) return metas;
      } else {
        // Since Feb 2026 this only works for playlists the app's own account owns.
        const data = await api(`/playlists/${id}/items?limit=50`);
        const metas = (data?.items || []).map((i) => toMeta(i.item || i.track)).filter(Boolean);
        if (metas.length) return metas;
      }
      log.info(`${kind} ${id}: the API returned no songs; trying the public page`);
    } catch (e) {
      log.info(`${kind} ${id}: API refused (${e.message}); trying the public page`);
    }
  }
  return fromEmbed(kind, id);
}

module.exports = { configured, searchTracks, parseLink, fromLink, toMeta, metaFromPage, fromEmbed, embedEntity, embedToMeta, _reset: () => (token = null) };
