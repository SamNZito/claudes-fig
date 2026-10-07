'use strict';
// Turns a probed track into PCM: `yt-dlp --load-info-json <probe> -o - | ffmpeg ... s16le`.
// The probe (music/resolve.js) already chose a real, full-length audio format, so this only downloads.
// Emits:
//   'ready'   first PCM bytes arrived
//   'started' the mixer actually pulled audio: the song is audible in the channel
//   'failed'  (reason, kind) no audio came out
//   'ended'   ({ early, positionMs, durationMs, reason, kind }) the stream ran out
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PcmSource } = require('./pcmSource');
const { ffmpegPath, ytdlpSpawn, ytdlpBaseArgs, AUDIO_FORMAT } = require('./binaries');
const { classify, sourceOf } = require('../music/sources');
const { config } = require('../config');
const log = require('../log').logger('track');

function lastLines(text, n = 3) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' | ');
}

/** Kept for older callers: the human reason only. */
function friendlyReason(stderr, source) {
  return classify(stderr, source).reason;
}

class TrackSource extends EventEmitter {
  /**
   * @param {object} track { url, title, key, duration }
   * @param {object} [opts] { startSec, infoPath }
   */
  constructor(track, { startSec = 0, infoPath = null } = {}) {
    super();
    this.track = track;
    this.source = sourceOf(track);
    this.startSec = startSec;
    this.infoPath = infoPath;
    this.pcm = new PcmSource({ label: track.title });
    this.ytErr = '';
    this.ffErr = '';
    this.done = false;
    this.ffmpegExit = null;
    this.killed = false;
    this.startTimer = null;
  }

  get stderr() {
    return `${this.ytErr}\n${this.ffErr}`;
  }

  start() {
    const ytArgs = [...ytdlpBaseArgs(), '--quiet', '-f', AUDIO_FORMAT, '-o', '-'];
    // Seek in the downloader. ffmpeg -ss on a pipe would decode from the top first.
    if (this.startSec > 1) ytArgs.push('--download-sections', `*${Math.floor(this.startSec)}-inf`);
    if (this.infoPath) ytArgs.push('--load-info-json', this.infoPath);
    else ytArgs.push(this.track.url);
    const ffArgs = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn'];
    if (config.normalizeAudio) ffArgs.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
    ffArgs.push('-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');

    log.debug(`download ${this.track.key || this.track.url} start=${this.startSec}s probe=${this.infoPath ? 'yes' : 'no'}`);
    try {
      this.yt = spawn(...ytdlpSpawn(ytArgs), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.ff = spawn(ffmpegPath(), ffArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.fail(`could not start downloader: ${e.message}`, 'tooling');
      return this;
    }

    const onSpawnError = (name) => (err) => {
      if (err.code === 'ENOENT') this.fail(`${name} is not installed or not on PATH`, 'tooling');
      else this.fail(`${name} error: ${err.message}`, 'unknown');
    };
    this.yt.on('error', onSpawnError('yt-dlp'));
    this.ff.on('error', onSpawnError('ffmpeg'));
    this.yt.stderr.on('data', (d) => (this.ytErr = (this.ytErr + d.toString()).slice(-4000)));
    this.ff.stderr.on('data', (d) => (this.ffErr = (this.ffErr + d.toString()).slice(-2000)));
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
      if (this.pcm.received === 0) this.failFromStderr();
    });
    this.yt.on('close', (code) => {
      this.ytExit = code;
      if (code !== 0 && !this.killed) log.info(`yt-dlp exited ${code} for ${this.track.key}: ${lastLines(this.ytErr) || '(no message)'}`);
    });

    this.startTimer = setTimeout(() => {
      if (this.pcm.received === 0) this.fail(`timed out after ${config.trackStartTimeoutSec}s waiting for audio`, 'timeout');
    }, config.trackStartTimeoutSec * 1000);

    return this;
  }

  failFromStderr() {
    // yt-dlp's message says why; ffmpeg's "Invalid data" only says that nothing usable arrived.
    const c = classify(this.ytErr.trim() ? this.ytErr : this.stderr, this.source);
    this.fail(c.reason, c.kind);
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

  fail(reason, kind = 'unknown') {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.startTimer);
    log.warn(`cannot play "${this.track.title}" ${this.track.key || ''}: ${kind}: ${reason}${this.stderr.trim() ? ` (${lastLines(this.stderr)})` : ''}`);
    this.kill();
    this.emit('failed', reason, kind);
  }

  finish() {
    if (this.done) return;
    if (this.pcm.received === 0) return this.failFromStderr();
    this.done = true;
    clearTimeout(this.startTimer);
    const positionMs = this.startSec * 1000 + this.pcm.positionMs;
    const durMs = (this.track.duration || 0) * 1000;
    const early = durMs > 0 && positionMs < durMs - 10000;
    const c = early && this.stderr.trim() ? classify(this.stderr, this.source) : { kind: null, reason: null };
    this.kill();
    this.emit('ended', { early, positionMs, durationMs: durMs, reason: c.reason, kind: c.kind, ytExit: this.ytExit });
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
