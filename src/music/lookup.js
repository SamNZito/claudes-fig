'use strict';
// What did they ask for? Turns "play X" into one or more song requests. No audio is touched here.
//   Spotify link (track / album / playlist) -> the exact songs, from Spotify
//   SoundCloud link                          -> that exact upload
//   YouTube link                             -> its title, then looked up like text (YouTube is never played)
//   text                                     -> Spotify search for the real artist/title/length (if configured),
//                                               otherwise SoundCloud search
const spotify = require('./spotify');
const { searchSource, runYtdlp, toTrack, isUrl } = require('./search');
const log = require('../log').logger('lookup');

function isSoundCloud(u) {
  return /^https?:\/\/(www\.|m\.|on\.)?soundcloud\.com\//i.test(u) || /^https?:\/\/snd\.sc\//i.test(u);
}
function isYouTube(u) {
  return /^https?:\/\/((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(u);
}

async function youtubeTitle(url) {
  const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`YouTube link lookup failed (${res.status})`);
  const data = await res.json();
  return String(data.title || '').trim();
}

/**
 * @returns {Promise<{ok:true, items:Array<{asked:string, meta?:object, candidates?:object[], pinned?:string}>} | {ok:false, error:string}>}
 */
async function lookup(query) {
  let q = String(query || '').trim();
  if (!q) return { ok: false, error: 'What should I play?' };

  const sp = spotify.parseLink(q);
  if (sp) {
    try {
      const metas = await spotify.fromLink(sp);
      if (!metas.length) return { ok: false, error: 'That Spotify link has no songs I can see' };
      return { ok: true, items: metas.map((m) => ({ asked: m.asked, meta: m })), source: 'spotify-link' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  if (isUrl(q) && isSoundCloud(q)) {
    try {
      const items = await runYtdlp(['--flat-playlist', '--dump-json', '--playlist-end', '50', q], 45000);
      const tracks = items.map(toTrack).filter(Boolean);
      if (!tracks.length) return { ok: false, error: "I couldn't open that SoundCloud link" };
      return { ok: true, items: tracks.map((t) => ({ asked: t.title, candidates: [t], pinned: t.key })), source: 'soundcloud-link' };
    } catch (e) {
      return { ok: false, error: `I couldn't open that SoundCloud link: ${e.message}` };
    }
  }

  if (isUrl(q) && isYouTube(q)) {
    try {
      const title = await youtubeTitle(q);
      if (!title) throw new Error('no title');
      log.info(`YouTube link -> "${title}" (looking it up on Spotify/SoundCloud; YouTube is not used)`);
      q = title;
    } catch (e) {
      return { ok: false, error: "I don't play from YouTube. Tell me the song name, or send a Spotify or SoundCloud link" };
    }
  } else if (isUrl(q)) {
    return { ok: false, error: 'I can play Spotify and SoundCloud links, or just tell me the song name' };
  }

  // Text.
  if (spotify.configured()) {
    try {
      const metas = await spotify.searchTracks(q, { limit: 5 });
      if (metas.length) return { ok: true, items: [{ asked: metas[0].asked, meta: metas[0], typed: q }], source: 'spotify-search' };
      log.info(`Spotify found nothing for "${q}"; trying SoundCloud directly`);
    } catch (e) {
      log.warn(`Spotify search failed (${e.message}); trying SoundCloud directly`);
    }
  }
  try {
    const tracks = await searchSource('soundcloud', q, { limit: 6 });
    if (!tracks.length) return { ok: false, error: `I couldn't find anything for "${q}"` };
    return { ok: true, items: [{ asked: q, candidates: tracks }], source: 'soundcloud-search' };
  } catch (e) {
    return { ok: false, error: `search failed: ${e.message}` };
  }
}

module.exports = { lookup, isSoundCloud, isYouTube, youtubeTitle };
