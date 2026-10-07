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
  if (!res.ok) throw new Error(`Spotify login failed (${res.status}): check SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET`);
  const data = await res.json();
  token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return token.value;
}

async function api(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      headers: { Authorization: `Bearer ${await getToken()}` },
      signal: AbortSignal.timeout(15000),
    });
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

/**
 * Expand a Spotify link into songs.
 * @returns {Promise<object[]>} metas
 */
async function fromLink(link) {
  const { kind, id } = link;
  if (!configured()) {
    if (kind === 'track') return [await metaFromPage('track', id)];
    throw new Error('Spotify album/playlist links need SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env');
  }
  if (kind === 'track') return [toMeta(await api(`/tracks/${id}`))].filter(Boolean);
  if (kind === 'album') {
    const album = await api(`/albums/${id}`);
    const items = album?.tracks?.items || [];
    return items.slice(0, 50).map((t) => toMeta({ ...t, artists: t.artists?.length ? t.artists : album.artists })).filter(Boolean);
  }
  // Playlists: since Feb 2026 Spotify only returns items for playlists the app's own user owns.
  try {
    const data = await api(`/playlists/${id}/items?limit=50`);
    const metas = (data?.items || []).map((i) => toMeta(i.item || i.track)).filter(Boolean);
    if (!metas.length) throw new Error('empty');
    return metas;
  } catch (e) {
    log.warn(`playlist ${id}: ${e.message}`);
    throw new Error("Spotify won't share that playlist's songs with bots (only albums, tracks, or playlists owned by the app's account)");
  }
}

module.exports = { configured, searchTracks, parseLink, fromLink, toMeta, metaFromPage, _reset: () => (token = null) };
