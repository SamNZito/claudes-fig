'use strict';
// "SoundCloud only has a preview of the original. Closest full version: ..."
//
// When a requested song is only available as a preview or DRM-locked (usual for major-label songs on
// SoundCloud), look for another full-length version people might accept: a cover, a live take, a
// remix of the same song. Fig only OFFERS it; it plays when someone says "Fig, play that".
const { searchSource } = require('./search');
const { probe } = require('./resolve');
const { tokens, matchesAsk } = require('./identity');
const { unaskedVersions } = require('./rank');
const scinfo = require('./scinfo');
const sources = require('./sources');
const log = require('../log').logger('alternatives');

const MIN_SEC = 60; // a 30 s preview or a short clip is not "a full version"
const MAX_PROBES = 3;

/**
 * The song's name without the artist: "Vince Guaraldi Trio - O Tannenbaum" -> "O Tannenbaum".
 * From Spotify when we have it; otherwise from the best-matching upload's title (a typed request like
 * "vince guaraldi trio o tannenbaum" doesn't say where the artist ends).
 */
function songTitle(entry) {
  const clean = (s) =>
    String(s || '')
      .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  if (entry?.meta?.title) return clean(entry.meta.title) || entry.meta.title;
  const best = [...(entry?.candidates || [])].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))[0];
  const fromUpload = best ? clean(best.title).split(/\s+[-–]\s+/).pop() : '';
  if (fromUpload && tokens(fromUpload).size) return fromUpload;
  const asked = String(entry?.asked || entry?.title || '');
  const dash = asked.split(/\s+-\s+/);
  return dash.length > 1 ? dash.slice(1).join(' - ') : asked;
}

/**
 * Find one full-length upload of the same song (another version is fine). Never throws.
 * @returns {Promise<null | {title, uploader, url, durationSec, key, versions: string[]}>}
 */
async function findAlternative(entry, { aborted = () => false } = {}) {
  const title = songTitle(entry);
  if (!tokens(title).size || !sources.isUp('soundcloud')) return null;
  const tried = entry.tried || new Set();
  let found;
  try {
    found = await searchSource('soundcloud', title, { limit: 8 });
  } catch (e) {
    log.warn(`search for other versions of "${title}" failed: ${e.message}`);
    return null;
  }
  // Same song name (the uploader doesn't matter: a cover by someone else is the point), not tried yet.
  let pool = found.filter((t) => !tried.has(t.key) && matchesAsk(title, { title: t.title, channel: '' }) >= 0.8);
  if (!pool.length) {
    log.info(`no other versions of "${title}" on SoundCloud`);
    return null;
  }
  // Skip the ones SoundCloud already says are locked.
  const infos = await scinfo.lookupTracks(pool.map((t) => t.id));
  pool = pool.filter((t) => {
    const info = infos.get(String(t.id));
    return !info || scinfo.verdict(info).playable;
  });
  // Closest first: the song's words, then the length nearest the original.
  const want = entry?.meta?.durationSec || 0;
  pool.sort((a, b) => matchesAsk(title, { title: b.title }) - matchesAsk(title, { title: a.title }) || (want ? Math.abs(a.duration - want) - Math.abs(b.duration - want) : 0));
  for (const t of pool.slice(0, MAX_PROBES)) {
    if (aborted()) return null;
    const p = await probe(t);
    if (!p.ok || (p.duration && p.duration < MIN_SEC)) {
      log.info(`other version "${t.title}" ${t.key}: ${p.ok ? `only ${Math.round(p.duration)}s` : p.reason}`);
      continue;
    }
    const alt = {
      title: t.title,
      uploader: t.channel || '',
      url: p.pageUrl || t.url,
      durationSec: Math.round(p.duration || t.duration || 0),
      key: t.key,
      versions: unaskedVersions(t.title, title),
    };
    log.info(`closest full version of "${title}": "${alt.title}" by ${alt.uploader || '?'} ${alt.key} ${alt.durationSec}s`);
    return alt;
  }
  log.info(`no full-length other version of "${title}" (checked ${Math.min(pool.length, MAX_PROBES)})`);
  return null;
}

module.exports = { findAlternative, songTitle };
