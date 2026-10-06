'use strict';
// Turns a track URL into PCM using `yt-dlp -o - URL | ffmpeg ... s16le`.
// Emits:
//   'ready'   first PCM bytes arrived (it can be heard as soon as the mixer pulls it)
//   'started' the mixer actually pulled audio: the song is audible in the channel
//   'failed'  (reason) nothing playable came out
//   'ended'   ({ early, positionMs, reason }) all audio was played
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PcmSource } = require('./pcmSource');
const { ffmpegPath, ytdlpSpawn, ytdlpBaseArgs, AUDIO_FORMAT } = require('./binaries');
const { config } = require('../config');
const log = require('../log').logger('track');

function lastLines(text, n = 3) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' | ');
}

function friendlyReason(stderr) {
  const s = stderr.toLowerCase();
  if (s.includes('age-restricted') || s.includes('confirm your age') || s.includes('inappropriate for some users')) return 'it is age-restricted';
  if (s.includes('sign in to confirm') || s.includes('not a bot')) return 'YouTube blocked the download (sign-in check)';
  if (s.includes('drm')) return 'it is DRM protected';
  if (s.includes('video unavailable') || s.includes('private video')) return 'the video is unavailable';
  if (s.includes('age')) return 'it is age-restricted';
  if (s.includes('copyright')) return 'it was blocked for copyright';
  if (s.includes('403')) return 'the host refused the download (403)';
  if (s.includes('requested format is not available')) return 'no audio format was available';
  if (s.includes('no supported javascript runtime') || s.includes('js runtime')) return 'yt-dlp needs a JavaScript runtime (install deno)';
  if (s.includes('enoent') || s.includes('not recognized')) return 'yt-dlp or ffmpeg is not installed';
  return lastLines(stderr, 1) || 'unknown error';
}

class TrackSource extends EventEmitter {
  /**
   * @param {object} track { url, title }
   * @param {object} [opts] { startSec }
   */
  constructor(track, { startSec = 0 } = {}) {
    super();
    this.track = track;
    this.startSec = startSec;
    this.pcm = new PcmSource({ label: track.title });
    this.stderr = '';
    this.done = false;
    this.ffmpegExit = null;
    this.killed = false;
    this.startTimer = null;
    this.stallTimer = null;
  }

  start() {
    const ytArgs = [...ytdlpBaseArgs(), '--no-playlist', '-f', AUDIO_FORMAT, '--quiet', '-o', '-'];
    // Seek in the downloader. ffmpeg -ss on a pipe replays the song from the top first.
    if (this.startSec > 1) ytArgs.push('--download-sections', `*${Math.floor(this.startSec)}-inf`);
    ytArgs.push(this.track.url);
    const ffArgs = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn'];
    if (config.normalizeAudio) ffArgs.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
    ffArgs.push('-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');

    log.debug(`spawn yt-dlp for ${this.track.url}`);
    try {
      this.yt = spawn(...ytdlpSpawn(ytArgs), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.ff = spawn(ffmpegPath(), ffArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.fail(`could not start downloader: ${e.message}`);
      return this;
    }

    const onSpawnError = (name) => (err) => {
      this.stderr += `\n${name}: ${err.code || ''} ${err.message}`;
      this.fail(err.code === 'ENOENT' ? `${name} is not installed or not on PATH` : `${name} error: ${err.message}`);
    };
    this.yt.on('error', onSpawnError('yt-dlp'));
    this.ff.on('error', onSpawnError('ffmpeg'));
    this.yt.stderr.on('data', (d) => (this.stderr = (this.stderr + d.toString()).slice(-4000)));
    this.ff.stderr.on('data', (d) => (this.stderr = (this.stderr + d.toString()).slice(-4000)));
    this.ff.stdin.on('error', () => {}); // EPIPE when we kill things; harmless
    this.yt.stdout.on('error', () => {});
    this.yt.stdout.pipe(this.ff.stdin);

    this.pcm.attach(this.ff.stdout);
    this.pcm.once('firstData', () => {
      clearTimeout(this.startTimer);
      this.emit('ready');
    });
    this.pcm.once('started', () => this.emit('started'));
    this.pcm.on('drained', () => {
      if (this.ffmpegExit !== null) this.finish();
      else this.ff.once('close', () => this.finish());
    });

    this.ff.on('close', (code) => {
      this.ffmpegExit = code;
      if (this.pcm.received === 0) {
        this.fail(friendlyReason(this.stderr));
      }
    });
    this.yt.on('close', (code) => {
      if (code !== 0 && !this.killed) log.debug(`yt-dlp exited ${code}: ${lastLines(this.stderr)}`);
    });

    this.startTimer = setTimeout(() => {
      if (this.pcm.received === 0) this.fail(`timed out after ${config.trackStartTimeoutSec}s waiting for audio`);
    }, config.trackStartTimeoutSec * 1000);

    return this;
  }

  /** Called by the player every few seconds while this track is current and unpaused. */
  checkStall(isBeingPulled) {
    if (this.done || !isBeingPulled) {
      this.lastProgress = { at: Date.now(), bytes: this.pcm.received };
      return false;
    }
    const now = Date.now();
    if (!this.lastProgress || this.pcm.received !== this.lastProgress.bytes || this.pcm.hasData) {
      this.lastProgress = { at: now, bytes: this.pcm.received };
      return false;
    }
    return now - this.lastProgress.at > config.stallTimeoutSec * 1000 && !this.pcm.inputEnded;
  }

  fail(reason) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.startTimer);
    log.warn(`cannot play "${this.track.title}": ${reason}${this.stderr ? ` (${lastLines(this.stderr)})` : ''}`);
    this.kill();
    this.emit('failed', reason);
  }

  finish() {
    if (this.done) return;
    if (this.pcm.received === 0) return this.fail(friendlyReason(this.stderr));
    this.done = true;
    clearTimeout(this.startTimer);
    const positionMs = this.startSec * 1000 + this.pcm.positionMs;
    const durMs = (this.track.duration || 0) * 1000;
    const early = durMs > 0 && positionMs < durMs - 10000;
    this.kill();
    this.emit('ended', { early, positionMs, reason: early ? friendlyReason(this.stderr) : null });
  }

  get positionMs() {
    return this.startSec * 1000 + this.pcm.positionMs;
  }

  kill() {
    if (this.killed) return;
    this.killed = true;
    clearTimeout(this.startTimer);
    for (const p of [this.yt, this.ff]) {
      try {
        if (p && p.exitCode === null) p.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }

  /** Throw away everything: processes and buffered audio. */
  destroy() {
    this.done = true;
    this.kill();
    this.pcm.destroy();
  }
}

module.exports = { TrackSource, friendlyReason };
