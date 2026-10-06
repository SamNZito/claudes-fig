'use strict';
// Finds ffmpeg and yt-dlp. ffmpeg falls back to the ffmpeg-static npm package when it is not on PATH.
const { spawnSync } = require('node:child_process');
const { config } = require('../config');

let ffmpegCached = null;

function works(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 15000, windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

function ffmpegPath() {
  if (ffmpegCached) return ffmpegCached;
  const candidates = [];
  if (config.ffmpegPath) candidates.push(config.ffmpegPath);
  candidates.push('ffmpeg');
  try {
    const p = require('ffmpeg-static');
    if (p) candidates.push(p);
  } catch {
    /* optional */
  }
  for (const c of candidates) {
    if (works(c, ['-version'])) {
      ffmpegCached = c;
      return c;
    }
  }
  ffmpegCached = config.ffmpegPath || 'ffmpeg';
  return ffmpegCached;
}

function ytdlpPath() {
  return config.ytdlpPath || 'yt-dlp';
}

/** [command, args] for spawning yt-dlp. A .js path (used by tests) runs through this Node binary, so it works on Windows too. */
function ytdlpSpawn(args) {
  const p = ytdlpPath();
  if (/\.(c|m)?js$/i.test(p)) return [process.execPath, [p, ...args]];
  return [p, args];
}

function ytdlpBaseArgs() {
  const args = ['--no-warnings', '--no-progress', '--no-playlist', '--ignore-config'];
  // Default YouTube client serves formats that 403. web_safari + a progressive/HLS
  // format actually returns audio. YouTube-only, so SoundCloud is unaffected.
  args.push('--extractor-args', 'youtube:player_client=web_safari', '--force-ipv4');
  if (config.ytdlpCookies) args.push('--cookies', config.ytdlpCookies);
  args.push(...config.ytdlpExtraArgs);
  return args;
}

// Prefer formats that download. bestaudio often picks a stream the CDN then refuses.
const AUDIO_FORMAT = '18/91/92/93/ba/b';

module.exports = { ffmpegPath, ytdlpPath, ytdlpSpawn, ytdlpBaseArgs, AUDIO_FORMAT, works };
