'use strict';
// Hears people in the voice channel. One short-lived subscription per utterance per person:
// Discord tells us someone started speaking, we collect their Opus packets until they have been
// silent for VAD_SILENCE_MS, decode to PCM, and hand a 16 kHz mono WAV to speech-to-text.
const { EventEmitter } = require('node:events');
const { EndBehaviorType } = require('@discordjs/voice');
const { createDecoder, usingNative } = require('../audio/opus');
const { BYTES_PER_MS } = require('../audio/constants');
const { config } = require('../config');
const log = require('../log').logger('listen');

const MIN_RMS = 120; // below this the "utterance" is breathing / keyboard noise

function pcmStats(pcm) {
  // pcm: s16le stereo 48k. Returns RMS of the mono mix.
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 3 < pcm.length; i += 4 * 4) {
    const v = (pcm.readInt16LE(i) + pcm.readInt16LE(i + 2)) / 2;
    sum += v * v;
    n++;
  }
  return { rms: n ? Math.sqrt(sum / n) : 0 };
}

/** 48 kHz stereo s16le -> 16 kHz mono s16le WAV. */
function toWav16kMono(pcm) {
  const frames = Math.floor(pcm.length / 4);
  const outSamples = Math.floor(frames / 3);
  const data = Buffer.alloc(outSamples * 2);
  for (let j = 0; j < outSamples; j++) {
    let acc = 0;
    for (let k = 0; k < 3; k++) {
      const off = (j * 3 + k) * 4;
      acc += pcm.readInt16LE(off) + pcm.readInt16LE(off + 2);
    }
    let v = Math.round(acc / 6);
    v = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    data.writeInt16LE(v, j * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

class Listener extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('@discordjs/voice').VoiceConnection} opts.connection
   * @param {(userId:string)=>boolean} opts.shouldListen
   */
  constructor({ connection, shouldListen }) {
    super();
    this.connection = connection;
    this.shouldListen = shouldListen;
    this.active = new Map();
    this.onStart = (userId) => this.handleStart(userId);
    this.stopped = false;
  }

  start() {
    this.connection.receiver.speaking.on('start', this.onStart);
    log.info(`listening (${usingNative() ? 'native opus' : 'opusscript'})`);
  }

  stop() {
    this.stopped = true;
    try {
      this.connection.receiver.speaking.off('start', this.onStart);
    } catch {
      /* ignore */
    }
    for (const { stream } of this.active.values()) {
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
    }
    this.active.clear();
  }

  handleStart(userId) {
    if (this.stopped || this.active.has(userId)) return;
    if (!this.shouldListen(userId)) return;
    let stream;
    try {
      stream = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: config.vadSilenceMs } });
    } catch (e) {
      log.debug('subscribe failed:', e.message);
      return;
    }
    let decoder;
    try {
      decoder = createDecoder();
    } catch (e) {
      const now = Date.now();
      if (!this.decoderWarnAt || now - this.decoderWarnAt > 15000) {
        this.decoderWarnAt = now;
        log.warn(`could not start decoder: ${e.message}`);
      }
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    const chunks = [];
    let bytes = 0;
    let done = false;
    const maxBytes = config.maxUtteranceSec * 1000 * BYTES_PER_MS;
    const state = { stream, startedAt: Date.now() };
    this.active.set(userId, state);
    this.emit('speechStart', userId);

    stream.on('data', (packet) => {
      if (done) return;
      try {
        const pcm = decoder.decode(packet);
        chunks.push(pcm);
        bytes += pcm.length;
        if (bytes >= maxBytes) stream.destroy();
      } catch {
        /* corrupt / undecryptable packet: skip it */
      }
    });
    stream.on('error', (e) => log.debug(`receive stream error for ${userId}: ${e.message}`));
    const finish = () => {
      if (done) return;
      done = true;
      this.active.delete(userId);
      try {
        decoder.destroy();
      } catch {
        /* wasm decoder can throw memory access out of bounds on teardown */
      }
      this.emit('speechEnd', userId);
      if (this.stopped) return;
      const pcm = Buffer.concat(chunks);
      const durationMs = pcm.length / BYTES_PER_MS;
      if (durationMs < config.minUtteranceMs) return;
      const { rms } = pcmStats(pcm);
      if (rms < MIN_RMS) return;
      this.emit('utterance', { userId, wav: toWav16kMono(pcm), durationMs });
    };
    stream.once('end', finish);
    stream.once('close', finish);
  }
}

module.exports = { Listener, toWav16kMono, pcmStats };
