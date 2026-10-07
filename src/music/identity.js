'use strict';
// "Is this the same song?" across sources and uploads.
//
// Playback identity is still the source key (youtube:<id>, soundcloud:<id>): two uploads are two
// tracks. But a skip, the DJ's memory, and picking a fallback copy all need to recognise the SONG,
// whichever upload it is: "Eagles - Please Come Home for Christmas (2013 Remaster)" on SoundCloud is
// the same song someone just skipped on YouTube. This file is the one place that decides that.

// Words that never tell two songs apart.
const NOISE = new Set([
  'official', 'video', 'audio', 'lyrics', 'lyric', 'hd', 'hq', '4k', '8k', 'visualizer', 'visualiser', 'mv', 'm', 'v',
  'remaster', 'remastered', 'remasterd', 'version', 'ver', 'edit', 'radio', 'mono', 'stereo', 'explicit', 'clean',
  'full', 'song', 'songs', 'topic', 'feat', 'ft', 'featuring', 'with', 'the', 'a', 'an', 'and', 'of', 'by', 'x', 'vs',
  'prod', 'original', 'single', 'album', 'music', 'high', 'quality', 'free', 'download', 'new', 'out', 'now',
  'vevo', 'records', 'recordings', 'entertainment', 'channel', 'tv', 'oficial', 'en', 'de', 'la', 'le', 'el',
  'track', 'sings', 'sung',
]);
// Words that DO make it a different recording; kept even inside brackets.
const MARKERS = /\b(remix|rmx|live|acoustic|instrumental|karaoke|slowed|reverb|sped|nightcore|8d|cover|mashup|bootleg|vip|demo|unplugged|parody)\b/i;

function tokens(text) {
  let s = String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  // Bracketed decorations go, unless they mark a different recording.
  s = s.replace(/[([{【「]([^)\]}】」]*)[)\]}】」]/g, (m, inner) => (MARKERS.test(inner) ? ` ${inner} ` : ' '));
  s = s.replace(/\b(19|20)\d{2}\b/g, ' '); // years: "(2013 Remaster)"
  s = s.replace(/&/g, ' and ').replace(/['’]/g, '');
  const out = new Set();
  for (const w of s.split(/[^a-z0-9]+/)) {
    if (!w || w.length < 2) continue;
    if (NOISE.has(w)) continue;
    out.add(w);
  }
  return out;
}

function markers(text) {
  const found = new Set();
  for (const m of String(text || '').toLowerCase().matchAll(new RegExp(MARKERS.source, 'gi'))) found.add(m[1].toLowerCase());
  return found;
}

/** Tokens for a track: title plus uploader, because SoundCloud titles often leave the artist out. */
function trackTokens(t) {
  if (!t) return new Set();
  if (t instanceof Set) return t;
  if (Array.isArray(t)) return new Set(t);
  if (typeof t === 'string') return tokens(t);
  return tokens(`${t.title || ''} ${t.channel || t.uploader || ''}`);
}

/**
 * How much of the smaller description is in the larger one (0..1).
 * Single-word titles must match exactly, so "Dreams" never equals "Sweet Dreams".
 */
function containment(a, b) {
  const A = trackTokens(a);
  const B = trackTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const small = Math.min(A.size, B.size);
  if (small === 1) return A.size === B.size && inter === 1 ? 1 : 0;
  return inter / small;
}

/**
 * Same song? `a`/`b` are track objects ({title, channel}), strings, or token sets.
 * Recordings with different markers (remix vs original, live vs studio) are different.
 */
function sameSong(a, b, threshold = 0.8) {
  const ta = typeof a === 'string' ? a : a?.title;
  const tb = typeof b === 'string' ? b : b?.title;
  if (typeof ta === 'string' && typeof tb === 'string') {
    if ([...markers(ta)].sort().join() !== [...markers(tb)].sort().join()) return false;
  }
  return containment(a, b) >= threshold;
}

/**
 * Does a candidate upload look like the song that was asked for?
 * Looser than sameSong: the ask is usually "artist title" and uploads add or drop words.
 */
function matchesAsk(ask, track) {
  const want = tokens(ask);
  const have = trackTokens(track);
  if (!want.size || !have.size) return 0;
  let hit = 0;
  for (const w of want) if (have.has(w)) hit++;
  if (want.size === 1) return hit === 1 ? 1 : 0;
  return hit / want.size;
}

module.exports = { tokens, trackTokens, containment, sameSong, matchesAsk, markers };
