'use strict';
// Finds tracks with yt-dlp. Sources are tried in health order (see sources.js).
// A track's identity is its source id (e.g. "youtube:dQw4w9WgXcQ"), never its title,
// so two different uploads of the same song are two different tracks.
const { spawn } = require('node:child_process');
const { ytdlpSpawn, ytdlpBaseArgs } = require('../audio/binaries');
const { config } = require('../config');
const log = require('../log').logger('search');
const { tokens } = require('./identity');

function runYtdlp(args, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(...ytdlpSpawn([...ytdlpBaseArgs(), ...args]), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('yt-dlp search timed out'));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err = (err + d.toString()).slice(-3000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error('yt-dlp is not installed or not on PATH') : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('{'));
      const items = [];
      for (const l of lines) {
        try {
          items.push(JSON.parse(l));
        } catch {
          /* skip */
        }
      }
      if (items.length === 0 && code !== 0) reject(new Error(err.split('\n').filter(Boolean).pop() || `yt-dlp exited ${code}`));
      else resolve(items);
    });
  });
}

function toTrack(info) {
  if (!info || !info.id) return null;
  const extractor = String(info.ie_key || info.extractor_key || info.extractor || 'youtube').toLowerCase();
  let url = info.webpage_url || info.url || info.original_url;
  if (!url || !/^https?:/.test(url)) {
    if (extractor.includes('youtube')) url = `https://www.youtube.com/watch?v=${info.id}`;
    else return null;
  }
  const isLive = info.live_status === 'is_live' || info.is_live === true;
  return {
    key: `${extractor.replace('tab', '')}:${info.id}`,
    id: info.id,
    url,
    title: info.title || info.id,
    channel: info.channel || info.uploader || '',
    duration: Number(info.duration) || 0,
    isLive,
  };
}

function isUrl(q) {
  return /^https?:\/\//i.test(q.trim());
}

/** Normalised "what song is this" key (sorted meaningful words). Kept in history for the DJ. */
function songKey(title) {
  return [...tokens(title)].sort().join(' ');
}

function playable(t) {
  if (!t || t.isLive) return false;
  if (t.duration && t.duration > config.maxTrackMinutes * 60) return false;
  return true;
}

const PREFIX = { youtube: 'ytsearch', soundcloud: 'scsearch' };

/** Search one source. */
async function searchSource(source, query, { limit = 5 } = {}) {
  const q = String(query || '').trim();
  const prefix = PREFIX[source];
  if (!q || !prefix || isUrl(q)) return [];
  const n = source === 'soundcloud' ? Math.min(limit, 8) : limit;
  const items = await runYtdlp(['--flat-playlist', '--dump-json', `${prefix}${n}:${q}`]);
  return items.map(toTrack).filter(Boolean).filter(playable);
}

/**
 * Search for tracks. URLs are looked up directly. Otherwise sources are searched in health order
 * (a source that is refusing this machine is searched last), and the first source with results wins;
 * the resolver searches the others later only if needed.
 */
async function search(query, { limit = 5 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  if (isUrl(q)) {
    const items = await runYtdlp(['--flat-playlist', '--dump-json', '--no-playlist', '--playlist-end', '50', q], 45000);
    return items.map(toTrack).filter(Boolean).filter((t) => !t.isLive);
  }
  const sources = require('./sources');
  for (const src of sources.order()) {
    try {
      const found = await searchSource(src, q, { limit });
      if (found.length) return found;
    } catch (e) {
      log.warn(`${src} search failed for "${q}": ${e.message}`);
    }
  }
  return [];
}

/** SoundCloud only. */
async function searchSoundCloud(query, { limit = 3 } = {}) {
  return searchSource('soundcloud', query, { limit });
}

module.exports = { search, searchSource, searchSoundCloud, songKey, toTrack, runYtdlp, isUrl, playable };
