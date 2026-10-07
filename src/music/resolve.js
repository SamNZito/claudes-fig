'use strict';
// Turns a request ("please come home for christmas") into ONE copy that will really play, before
// anything is announced. Every candidate is probed with `yt-dlp -J` first:
//   - the probe picks the audio format, so a SoundCloud 30 s preview or a DRM stream is rejected
//     here instead of being played and then "ending";
//   - a refused source (YouTube bot check / 403 / no data) is detected on the first upload and the
//     whole source is skipped, instead of walking five more of its uploads;
//   - the probe result is saved and the download reuses it (--load-info-json), so nothing is
//     extracted twice.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ytdlpSpawn, ytdlpBaseArgs, AUDIO_FORMAT } = require('../audio/binaries');
const sources = require('./sources');
const { searchSource, isUrl } = require('./search');
const spotify = require('./spotify');
const { matchesAsk } = require('./identity');
const { config } = require('../config');
const log = require('../log').logger('resolve');

const PROBE_DIR = path.join(os.tmpdir(), 'fig-probes');
const PER_SOURCE_BAD_UPLOADS = 4; // unavailable / errored uploads tried per source per request

function probeTtlMs(source) {
  // Stream URLs expire. SoundCloud's quickly, YouTube's after a few hours.
  return source === 'soundcloud' ? 8 * 60 * 1000 : 90 * 60 * 1000;
}

/**
 * Probe one track. Resolves { ok:true, infoPath, duration, formatId, title, source, at } or
 * { ok:false, kind, reason, source }.
 */
function probe(track, { timeoutMs = config.probeTimeoutSec * 1000 } = {}) {
  const source = sources.sourceOf(track);
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(...ytdlpSpawn([...ytdlpBaseArgs(), '-J', '-f', AUDIO_FORMAT, track.url]), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, source, ...sources.classify(`${e.code || ''} ${e.message}`, source) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve({ ok: false, source, kind: 'timeout', reason: `${sources.label(source)} did not answer in ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err = (err + d.toString()).slice(-4000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, source, ...sources.classify(`${e.code || ''} ${e.message} yt-dlp is not installed`, source) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let info = null;
      const line = out.split(/\r?\n/).find((l) => l.trim().startsWith('{'));
      if (line) {
        try {
          info = JSON.parse(line);
        } catch {
          info = null;
        }
      }
      if (!info || code !== 0) {
        resolve({ ok: false, source, ...sources.classify(err || `yt-dlp exited ${code}`, source) });
        return;
      }
      const formatId = String(info.format_id || '');
      if (/preview/i.test(formatId)) {
        resolve({ ok: false, source, kind: 'preview', reason: 'only a 30-second preview exists for that copy' });
        return;
      }
      const duration = Number(info.duration) || 0;
      if (duration && duration < Math.min(30, config.minSongSec)) {
        resolve({ ok: false, source, kind: 'preview', reason: `that copy is only ${Math.round(duration)}s long` });
        return;
      }
      if (duration && track.duration && track.duration > 75 && duration < track.duration * 0.6) {
        resolve({ ok: false, source, kind: 'preview', reason: `that copy is ${Math.round(duration)}s of a ${Math.round(track.duration)}s song` });
        return;
      }
      try {
        fs.mkdirSync(PROBE_DIR, { recursive: true });
        const safe = String(track.key || info.id || 'track').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80);
        const infoPath = path.join(PROBE_DIR, `${safe}-${Date.now()}.json`);
        fs.writeFileSync(infoPath, line);
        cleanupProbes();
        resolve({ ok: true, source, infoPath, duration, formatId, title: info.title || track.title, at: Date.now() });
      } catch (e) {
        resolve({ ok: false, source, kind: 'unknown', reason: `could not save probe: ${e.message}` });
      }
    });
  });
}

let probesSinceCleanup = 0;
/** Probe files are small, but don't let them pile up forever. */
function cleanupProbes() {
  if (++probesSinceCleanup < 50) return;
  probesSinceCleanup = 0;
  try {
    const cutoff = Date.now() - 6 * 3600 * 1000;
    for (const f of fs.readdirSync(PROBE_DIR)) {
      const full = path.join(PROBE_DIR, f);
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch {
    /* ignore */
  }
}

function fresh(p) {
  return p && p.ok && Date.now() - p.at < probeTtlMs(p.source) && fs.existsSync(p.infoPath);
}

/** Does an upload's length fit the real song (from Spotify)? Previews, edits, mixes and wrong songs don't. */
function lengthFits(meta, seconds) {
  if (!meta?.durationSec || !seconds) return true;
  const r = seconds / meta.durationSec;
  return r >= 0.75 && r <= 1.35;
}

/** Spotify gives the real artist/title/length. Look it up once for requests that don't have it (DJ picks, typed fallbacks). */
async function ensureMeta(req) {
  if (req.meta || req.metaTried || req.pinned || !spotify.configured()) return;
  req.metaTried = true;
  try {
    const metas = await spotify.searchTracks(req.asked, { limit: 3 });
    const best = metas.find((m) => matchesAsk(req.asked, { title: m.title, channel: m.artists.join(' ') }) >= 0.5);
    if (best) {
      req.meta = best;
      log.info(`spotify: "${req.asked}" is "${best.asked}" (${best.durationSec}s)`);
    }
  } catch (e) {
    log.warn(`spotify lookup failed for "${req.asked}": ${e.message}`);
  }
}

/** SoundCloud search texts to try, most specific first. */
function searchTexts(req) {
  const out = [];
  const add = (t) => {
    const v = String(t || '').replace(/\s+/g, ' ').trim();
    if (v && !isUrl(v) && !out.includes(v)) out.push(v);
  };
  if (req.meta) {
    add(`${req.meta.artist} ${req.meta.title}`);
    add(req.meta.title.replace(/\s*[-(\[].*(remaster|version|edit|mono|stereo).*$/i, ''));
    add(req.meta.title);
  }
  add(req.typed);
  add(req.asked);
  return out.slice(0, 3);
}

/**
 * Find a playable copy for a request.
 * @param {object} req       queue entry: { asked, meta?, candidates[], tried:Set, via, explicit, pinned }
 * @param {object} opts
 * @param {(t)=>string|null} opts.blocked  reason this copy may not play (skipped song / DJ already played it)
 * @param {()=>boolean}      opts.aborted  true once the request was skipped or replaced
 * @returns {Promise<{ok:true, track, probe} | {ok:false, reason, kind}>}
 */
async function findPlayable(req, { blocked = () => null, aborted = () => false } = {}) {
  req.tried = req.tried || new Set();
  req.searchedTexts = req.searchedTexts || new Set();
  req.candidates = req.candidates || [];
  const deadline = Date.now() + config.resolveBudgetSec * 1000;
  const badPerSource = {};
  let firstReason = null;
  let firstKind = null;
  let lastReason = null;
  let probes = 0;

  const note = (r) => {
    lastReason = r.reason;
    if (!firstReason || (firstKind === 'timeout' && r.kind !== 'timeout')) {
      firstReason = r.reason;
      firstKind = r.kind;
    }
  };

  await ensureMeta(req);
  if (aborted()) return { ok: false, kind: 'aborted', reason: 'skipped' };
  const want = req.meta ? `${req.meta.artist} ${req.meta.title}` : req.asked;

  while (Date.now() < deadline && probes < 10) {
    if (aborted()) return { ok: false, kind: 'aborted', reason: 'skipped' };
    const order = sources.order();
    const pool = req.candidates
      .filter((t) => !req.tried.has(t.key))
      .filter((t) => sources.allowed(sources.sourceOf(t)))
      .filter((t) => sources.isUp(sources.sourceOf(t)) || (req.pinned && t.key === req.pinned))
      .filter((t) => (badPerSource[sources.sourceOf(t)] || 0) < PER_SOURCE_BAD_UPLOADS);
    pool.sort((a, b) => order.indexOf(sources.sourceOf(a)) - order.indexOf(sources.sourceOf(b)));
    let cand = null;
    for (const t of pool) {
      const why = blocked(t) || (!req.pinned && !lengthFits(req.meta, t.duration) ? `${Math.round(t.duration)}s doesn't fit a ${req.meta.durationSec}s song` : null);
      if (why) {
        req.tried.add(t.key);
        log.info(`skip candidate "${t.title}" ${t.key}: ${why}`);
        continue;
      }
      cand = t;
      break;
    }

    if (!cand) {
      if (req.pinned && !req.meta && req.tried.has(req.pinned) && !req.asked) break;
      // Out of candidates: run the next search (each working source x each search text).
      const text = searchTexts(req).find((t) => order.some((s) => sources.isUp(s) && !req.searchedTexts.has(`${s}|${t}`)));
      if (!text) break;
      const src = order.find((s) => sources.isUp(s) && !req.searchedTexts.has(`${s}|${text}`));
      req.searchedTexts.add(`${src}|${text}`);
      try {
        const found = await searchSource(src, text, { limit: 8 });
        if (aborted()) return { ok: false, kind: 'aborted', reason: 'skipped' };
        const scored = found
          .filter((t) => !req.candidates.some((c) => c.key === t.key))
          .map((t) => ({ t, score: matchesAsk(want, t), fit: req.meta?.durationSec && t.duration ? Math.abs(t.duration - req.meta.durationSec) : 0 }))
          .filter((x) => x.score >= 0.5)
          .sort((a, b) => b.score - a.score || a.fit - b.fit);
        log.info(`searched ${src} for "${text}": ${scored.length}/${found.length} look like "${want}"`);
        req.candidates.push(...scored.map((x) => x.t));
      } catch (e) {
        log.warn(`${src} search failed: ${e.message}`);
        note({ kind: 'unknown', reason: `${sources.label(src)} search failed` });
      }
      continue;
    }

    req.tried.add(cand.key);
    const src = sources.sourceOf(cand);
    probes++;
    log.info(`probe "${cand.title}" ${cand.key} for "${want}"`);
    const p = await probe(cand);
    if (aborted()) return { ok: false, kind: 'aborted', reason: 'skipped' };
    if (p.ok && !req.pinned && !lengthFits(req.meta, p.duration)) {
      note({ kind: 'preview', reason: `the copies I found are ${Math.round(p.duration)}s, not the full ${req.meta.durationSec}s song` });
      log.warn(`probe "${cand.title}" ${cand.key}: ${Math.round(p.duration)}s doesn't fit ${req.meta.durationSec}s; rejecting`);
      continue;
    }
    if (p.ok) {
      log.info(`probe ok "${cand.title}" ${cand.key} ${Math.round(p.duration)}s format=${p.formatId}`);
      return { ok: true, track: { ...cand, duration: p.duration || cand.duration, title: cand.title || p.title }, probe: p };
    }
    log.warn(`probe failed "${cand.title}" ${cand.key}: ${p.kind}: ${p.reason}`);
    note(p);
    if (p.kind === 'tooling') return { ok: false, kind: p.kind, reason: p.reason };
    if (p.kind === 'blocked') sources.markDown(src, p.reason);
    else if (p.kind === 'unavailable' || p.kind === 'age' || p.kind === 'timeout' || p.kind === 'unknown') {
      badPerSource[src] = (badPerSource[src] || 0) + 1;
    }
  }
  let reason = firstReason || lastReason || (req.candidates.length ? "every copy I found was a preview or wouldn't play" : `SoundCloud doesn't have "${want}"`);
  if (firstKind === 'preview' || firstKind === 'drm') reason = `SoundCloud only has previews or locked copies of "${want}"`;
  const down = sources.order().filter((s) => !sources.isUp(s)).map(sources.label);
  if (down.length && !/blocking|refus|no audio data|sent no audio/i.test(reason)) {
    reason = `${reason}, and ${down.join(' and ')} ${down.length > 1 ? 'are' : 'is'} refusing this server right now`;
  }
  return { ok: false, kind: firstKind || 'none', reason };
}

module.exports = { probe, findPlayable, fresh, PROBE_DIR };
