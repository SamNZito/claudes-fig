'use strict';
// Which music sources work from THIS machine right now, and why a download failed.
//
// The rule that fixes "five dead YouTube ids before SoundCloud": a failure is classified once.
//   blocked     the host is refused (bot check, 403, PO token, empty data). Every upload on that
//               source will fail the same way, so the source is marked down for a while and no more
//               of its uploads are tried. One failure is enough.
//   preview     SoundCloud only offers a 30 s snippet. Never played.
//   drm         encrypted stream. Never played.
//   unavailable / age / geo   this one upload is bad; another upload may work (max 2 per source).
//   tooling     yt-dlp/ffmpeg/deno missing. Nothing will work; stop and say so.
const { config } = require('../config');
const log = require('../log').logger('sources');

// SoundCloud only by default. YouTube is not used: it refuses cloud servers, and the room asked for it off.
// (MUSIC_SOURCES=soundcloud,youtube would turn it back on.) Spotify is a lookup service, not an audio source.
const KNOWN = ['soundcloud'];

function sourceOf(track) {
  const k = String(track?.key || '').toLowerCase();
  const u = String(track?.url || '').toLowerCase();
  if (k.startsWith('youtube') || /youtu\.?be/.test(u)) return 'youtube';
  if (k.startsWith('soundcloud') || u.includes('soundcloud.com')) return 'soundcloud';
  return k.split(':')[0] || 'other';
}

/**
 * @param {string} stderr yt-dlp + ffmpeg stderr
 * @returns {{kind:string, reason:string}}
 */
function classify(stderr, source = '') {
  const raw = String(stderr || '');
  const s = raw.toLowerCase();
  const has = (re) => re.test(s);
  if (has(/enoent|not recognized as an internal|no such file or directory.*(yt-dlp|ffmpeg)|is not installed/)) return { kind: 'tooling', reason: 'yt-dlp or ffmpeg is not installed' };
  if (has(/no supported javascript runtime|js runtime|javascript runtime|install deno/)) return { kind: 'tooling', reason: 'yt-dlp needs a JavaScript runtime (install deno)' };
  // Age must be checked before the bot check: "Sign in to confirm your age" also says "sign in to confirm".
  if (has(/confirm your age|age[- ]restricted|age restricted|inappropriate for some users/)) return { kind: 'age', reason: 'that upload is age-restricted' };
  if (has(/not a bot|confirm you.?re not|sign in to confirm/)) return { kind: 'blocked', reason: `${label(source)} is blocking downloads from this server (bot check)` };
  if (has(/po token|potoken|gvs po|only images are available|this content isn.?t available, try again later|rate.?limit|http error 429|too many requests/)) {
    return { kind: 'blocked', reason: `${label(source)} is refusing this server (needs a PO token or is rate limiting)` };
  }
  if (has(/drm protected|\bdrm\b/)) return { kind: 'drm', reason: 'that copy is DRM protected' };
  if (has(/preview only|only a preview|_preview|snipped/)) return { kind: 'preview', reason: 'only a 30-second preview exists for that copy' };
  if (has(/requested format is not available|no video formats found|no formats found/)) {
    // On SoundCloud we filter previews out, so "no format" means preview-only.
    if (source === 'soundcloud') return { kind: 'preview', reason: 'only a 30-second preview exists for that copy' };
    return { kind: 'blocked', reason: `${label(source)} returned no audio to this server` };
  }
  if (has(/http error 403|403: forbidden|\b403\b/)) return { kind: 'blocked', reason: `${label(source)} refused the download (403)` };
  if (has(/geo.?restrict|not available in your country|not made this video available in your country/)) return { kind: 'unavailable', reason: 'that upload is blocked in this region' };
  if (has(/video unavailable|private video|has been removed|does not exist|copyright|terminated|404/)) return { kind: 'unavailable', reason: 'that upload is unavailable' };
  if (has(/invalid data found when processing input/)) {
    // yt-dlp wrote nothing usable. On YouTube that is the server being refused, not a bad song.
    return source === 'youtube'
      ? { kind: 'blocked', reason: 'YouTube sent no audio data to this server' }
      : { kind: 'unavailable', reason: 'the download had no audio in it' };
  }
  if (has(/timed out|timeout/)) return { kind: 'timeout', reason: 'the download timed out' };
  const last = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  return { kind: 'unknown', reason: last ? last.replace(/^error:\s*/i, '').slice(0, 160) : 'unknown error' };
}

function label(source) {
  return source === 'youtube' ? 'YouTube' : source === 'soundcloud' ? 'SoundCloud' : source || 'the source';
}

// ---------- health (shared by every guild: it is about this machine) ----------

const health = new Map(); // source -> { downUntil, reason, strikes }

function state(source) {
  if (!health.has(source)) health.set(source, { downUntil: 0, reason: '', strikes: 0 });
  return health.get(source);
}

function isUp(source) {
  return Date.now() >= state(source).downUntil;
}

/** Mark a source refused. Cooldown doubles each time it is still refused (10 min .. 2 h). */
function markDown(source, reason) {
  const st = state(source);
  st.strikes = Math.min(st.strikes + 1, 5);
  const base = config.sourceCooldownMin * 60 * 1000;
  const ms = Math.min(base * 2 ** (st.strikes - 1), 2 * 60 * 60 * 1000);
  const wasUp = isUp(source);
  st.downUntil = Date.now() + ms;
  st.reason = reason;
  log.warn(`${label(source)} marked DOWN for ${Math.round(ms / 60000)} min: ${reason}`);
  if (wasUp) emitter.emit('down', source, reason, ms);
}

function markOk(source) {
  const st = state(source);
  if (st.strikes || st.downUntil) log.info(`${label(source)} is working again`);
  st.strikes = 0;
  st.downUntil = 0;
  st.reason = '';
}

function configured() {
  return (config.musicSources.length ? config.musicSources : KNOWN).filter(Boolean);
}

/** May audio come from this source at all? */
function allowed(source) {
  return configured().includes(source);
}

/** Configured order, working sources first. */
function order() {
  const list = configured();
  return [...list.filter(isUp), ...list.filter((s) => !isUp(s))];
}

function summary() {
  return configured().map((s) => {
    const st = state(s);
    return isUp(s) ? `${label(s)}: ok` : `${label(s)}: down ${Math.ceil((st.downUntil - Date.now()) / 60000)} more min (${st.reason})`;
  });
}

function reset() {
  health.clear();
}

const { EventEmitter } = require('node:events');
const emitter = new EventEmitter();

module.exports = { classify, sourceOf, isUp, allowed, markDown, markOk, order, summary, label, reset, events: emitter, KNOWN };
