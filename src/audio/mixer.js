'use strict';
// The mixer is the heart of Fig's sound. It owns two lanes:
//   music - at most one PcmSource (the current song). Can be paused by users.
//   voice - Fig's speech clips, played one after another. Music ducks under them.
// Discord's AudioPlayer pulls one 20 ms Opus packet at a time from a tiny object-mode stream
// (highWaterMark 2), so there is almost nothing buffered downstream. That is why a skip is
// instant and why a paused song never leaks a few seconds of audio.
//
// Pausing music is a flag on the music lane only. Fig talking never touches it, and neither does
// the voice connection dropping (the player just stops pulling frames until it is back).
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { FRAME_BYTES } = require('./constants');
const { createEncoder } = require('./opus');

const SILENCE_PCM = Buffer.alloc(FRAME_BYTES);
const IDLE_FRAMES_BEFORE_SLEEP = 15; // 300 ms of nothing before we tell the player to go quiet

function clamp16(v) {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v | 0;
}

class Mixer extends EventEmitter {
  constructor({ volume = 20, duckLevel = 0.25, duckMode = 'duck', voiceVolume = 1 } = {}) {
    super();
    this.encoder = createEncoder();
    this.silencePacket = this.encoder.encode(SILENCE_PCM);
    this.music = null;
    this.musicPaused = false;
    this.voiceQueue = []; // [{ source, resolve }]
    this.duckLevel = duckLevel;
    this.duckMode = duckMode;
    this.voiceVolume = voiceVolume;
    this.volumeTarget = volume / 100;
    this.volumeGain = this.volumeTarget;
    this.duckGain = 1;
    this.duckHoldUntil = 0;
    this.idle = true;
    this.idleFrames = 0;
    this.framesOut = 0;
  }

  // ---- music lane -------------------------------------------------------
  setMusic(source) {
    const old = this.music;
    this.music = source || null;
    if (old && old !== source) old.destroy();
    if (source) {
      if (source.hasData) this.wake();
      else source.once('firstData', () => this.music === source && this.wake());
    }
  }

  setMusicPaused(paused) {
    this.musicPaused = Boolean(paused);
    if (!paused && this.music) this.wake();
  }

  /** 0..100 */
  setVolume(volume) {
    this.volumeTarget = Math.max(0, Math.min(100, volume)) / 100;
  }

  // ---- voice lane -------------------------------------------------------
  /** Queue a fully decoded speech clip. Resolves when it has finished playing or was cut off. */
  addVoice(source) {
    return new Promise((resolve) => {
      this.voiceQueue.push({ source, resolve });
      this.wake();
    });
  }

  get voiceActive() {
    return this.voiceQueue.length > 0;
  }

  /** Stop talking right now. */
  stopVoice() {
    const q = this.voiceQueue;
    this.voiceQueue = [];
    for (const item of q) {
      item.source.destroy();
      item.resolve(false);
    }
  }

  /** Keep music ducked for a while (e.g. while someone is talking to Fig). */
  holdDuck(ms) {
    this.duckHoldUntil = Math.max(this.duckHoldUntil, Date.now() + ms);
  }

  // ---- engine -----------------------------------------------------------
  musicAudible() {
    const m = this.music;
    if (!m || this.musicPaused) return false;
    if (this.duckMode === 'wait' && this.voiceActive) return false;
    return m.hasData || (m.startedEmitted && !m.finished);
  }

  hasWork() {
    return this.voiceActive || this.musicAudible();
  }

  wake() {
    this.idleFrames = 0;
    if (this.idle) {
      this.idle = false;
      this.emit('active');
    }
  }

  /** Produce the next 20 ms of PCM. */
  nextFrame() {
    const ducking = this.voiceActive || Date.now() < this.duckHoldUntil;
    const duckTarget = ducking ? this.duckLevel : 1;
    const prevDuck = this.duckGain;
    // Duck quickly (~120 ms), come back gently (~400 ms).
    if (this.duckGain > duckTarget) this.duckGain = Math.max(duckTarget, this.duckGain - 0.12);
    else if (this.duckGain < duckTarget) this.duckGain = Math.min(duckTarget, this.duckGain + 0.04);
    const prevVol = this.volumeGain;
    const dv = this.volumeTarget - this.volumeGain;
    this.volumeGain += Math.abs(dv) < 0.02 ? dv : Math.sign(dv) * 0.02;

    const out = new Int32Array(FRAME_BYTES / 2);
    let any = false;

    if (this.musicAudible()) {
      const pcm = this.music.read(FRAME_BYTES);
      if (pcm.length) {
        any = true;
        const n = pcm.length >> 1;
        const g0 = prevVol * prevDuck;
        const g1 = this.volumeGain * this.duckGain;
        const total = out.length;
        for (let i = 0; i < n; i++) {
          const g = g0 + ((g1 - g0) * i) / total;
          out[i] += pcm.readInt16LE(i * 2) * g;
        }
      }
    }

    // voice lane
    while (this.voiceQueue.length && this.voiceQueue[0].source.finished) {
      const done = this.voiceQueue.shift();
      done.resolve(true);
    }
    if (this.voiceQueue.length) {
      const pcm = this.voiceQueue[0].source.read(FRAME_BYTES);
      if (pcm.length) {
        any = true;
        const n = pcm.length >> 1;
        const g = this.voiceVolume;
        for (let i = 0; i < n; i++) out[i] += pcm.readInt16LE(i * 2) * g;
      }
      if (this.voiceQueue[0].source.finished) {
        const done = this.voiceQueue.shift();
        done.resolve(true);
      }
    }

    if (this.hasWork() || any) {
      this.idleFrames = 0;
    } else if (!this.idle && ++this.idleFrames >= IDLE_FRAMES_BEFORE_SLEEP) {
      this.idle = true;
      this.emit('idle');
    }

    if (!any) return SILENCE_PCM;
    const buf = Buffer.allocUnsafe(FRAME_BYTES);
    for (let i = 0; i < out.length; i++) buf.writeInt16LE(clamp16(out[i]), i * 2);
    return buf;
  }

  nextPacket() {
    const pcm = this.nextFrame();
    this.framesOut++;
    if (pcm === SILENCE_PCM) return this.silencePacket;
    try {
      return this.encoder.encode(pcm);
    } catch (e) {
      this.emit('warn', `opus encode failed: ${e.message}`);
      return this.silencePacket;
    }
  }

  /** A fresh object-mode stream of Opus packets for an AudioResource. */
  createStream() {
    const self = this;
    return new Readable({
      objectMode: true,
      highWaterMark: 2,
      read() {
        this.push(self.nextPacket());
      },
    });
  }

  destroy() {
    this.stopVoice();
    if (this.music) this.music.destroy();
    this.music = null;
  }
}

module.exports = { Mixer, SILENCE_PCM };
