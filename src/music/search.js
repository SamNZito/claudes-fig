'use strict';
// Finds tracks with yt-dlp. YouTube first, SoundCloud as a fallback.
// A track's identity is its source id (e.g. "youtube:dQw4w9WgXcQ"), never its title,
// so two different uploads of the same song are two different tracks.
const { spawn } = require('node:child_process');
const { ytdlpSpawn, ytdlpBaseArgs } = require('../audio/binaries');
const { config } = require('../config');
const log = require('../log').logger('search');

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

/** Normalised "what song is this" key. Only used by the DJ to avoid replaying the same set. */
function songKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (m) => (/(remix|live|acoustic|cover|version|edit)/.test(m) ? m : ' '))
    .replace(/\b(official|music|video|audio|lyrics?|lyric video|hd|hq|4k|visualizer|m\/v|mv)\b/g, ' ')
    .replace(/\b(ft|feat|featuring)\.?\b.*$/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function playable(t) {
  if (!t || t.isLive) return false;
  if (t.duration && t.duration > config.maxTrackMinutes * 60) return false;
  return true;
}

/**
 * Search for tracks. Returns an array of tracks (best first).
 * @param {string} query
 * @param {object} [opts] { limit }
 */
async function search(query, { limit = 5 } = {}) {
  const q = query.trim();
  if (!q) return [];
  if (isUrl(q)) {
    const items = await runYtdlp(['--flat-playlist', '--dump-json', '--no-playlist', '--playlist-end', '50', q], 45000);
    return items.map(toTrack).filter(Boolean).filter((t) => !t.isLive);
  }
  let results = [];
  try {
    const items = await runYtdlp(['--flat-playlist', '--dump-json', `ytsearch${limit}:${q}`]);
    results = items.map(toTrack).filter(Boolean);
  } catch (e) {
    log.warn(`YouTube search failed for "${q}": ${e.message}`);
  }
  const good = results.filter(playable);
  if (good.length) return good;
  try {
    const items = await runYtdlp(['--flat-playlist', '--dump-json', `scsearch${Math.min(limit, 3)}:${q}`]);
    const sc = items.map(toTrack).filter(Boolean).filter(playable);
    if (sc.length) return sc;
  } catch (e) {
    log.warn(`SoundCloud search failed for "${q}": ${e.message}`);
  }
  return results.filter((t) => !t.isLive);
}

/** SoundCloud only. Used when a YouTube result exists but the audio will not download. */
async function searchSoundCloud(query, { limit = 3 } = {}) {
  const q = String(query || '').trim();
  if (!q || isUrl(q)) return [];
  const items = await runYtdlp(['--flat-playlist', '--dump-json', `scsearch${Math.min(limit, 3)}:${q}`]);
  return items.map(toTrack).filter(Boolean).filter(playable);
}

module.exports = { search, searchSoundCloud, songKey, toTrack, runYtdlp, isUrl, playable };
