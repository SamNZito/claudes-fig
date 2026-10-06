'use strict';
// A PCM (s16le, 48 kHz, stereo) source the mixer pulls fixed-size frames from.
// Wraps a Readable (usually ffmpeg stdout) and applies backpressure so we never hold more than
// a few seconds in memory. Destroying it drops every buffered byte instantly, which is what
// makes "skip" mean the old song is gone.
const { EventEmitter } = require('node:events');
const { BYTES_PER_MS } = require('./constants');

class PcmSource extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} [opts.maxBufferMs] pause the input when more than this is buffered
   * @param {string} [opts.label]
   */
  constructor({ maxBufferMs = 12000, label = 'pcm' } = {}) {
    super();
    this.label = label;
    this.chunks = [];
    this.head = 0; // offset into chunks[0]
    this.buffered = 0;
    this.maxBuffer = Math.round(maxBufferMs * BYTES_PER_MS);
    this.lowWater = Math.round(this.maxBuffer / 2);
    this.inputEnded = false;
    this.destroyed = false;
    this.received = 0; // bytes received from input
    this.consumed = 0; // bytes handed to the mixer
    this.startedEmitted = false;
    this.drainedEmitted = false;
    this.input = null;
    this.inputPaused = false;
  }

  /** Attach a readable stream as input. */
  attach(readable) {
    this.input = readable;
    readable.on('data', (chunk) => this.push(chunk));
    readable.on('end', () => this.end());
    readable.on('error', (err) => {
      if (!this.destroyed) this.emit('inputError', err);
      this.end();
    });
    return this;
  }

  /** Feed bytes directly (used for fully buffered clips such as TTS). */
  push(chunk) {
    if (this.destroyed || !chunk || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this.received += chunk.length;
    if (this.received === chunk.length) this.emit('firstData');
    if (this.input && !this.inputPaused && this.buffered > this.maxBuffer) {
      this.inputPaused = true;
      this.input.pause();
    }
  }

  end() {
    if (this.inputEnded) return;
    this.inputEnded = true;
    this.emit('inputEnd');
    if (this.buffered === 0) this._drained();
  }

  _drained() {
    if (this.drainedEmitted || this.destroyed) return;
    this.drainedEmitted = true;
    setImmediate(() => this.emit('drained'));
  }

  /** True once all input has arrived and been consumed. */
  get finished() {
    return this.destroyed || (this.inputEnded && this.buffered === 0);
  }

  get hasData() {
    return this.buffered > 0;
  }

  get positionMs() {
    return this.consumed / BYTES_PER_MS;
  }

  /**
   * Take up to n bytes. Returns a Buffer (possibly shorter than n, possibly empty).
   */
  read(n) {
    if (this.destroyed || this.buffered === 0) return Buffer.alloc(0);
    const want = Math.min(n, this.buffered);
    const out = Buffer.allocUnsafe(want);
    let written = 0;
    while (written < want) {
      const chunk = this.chunks[0];
      const available = chunk.length - this.head;
      const take = Math.min(available, want - written);
      chunk.copy(out, written, this.head, this.head + take);
      written += take;
      this.head += take;
      if (this.head >= chunk.length) {
        this.chunks.shift();
        this.head = 0;
      }
    }
    this.buffered -= want;
    this.consumed += want;
    if (!this.startedEmitted) {
      this.startedEmitted = true;
      this.emit('started');
    }
    if (this.input && this.inputPaused && this.buffered < this.lowWater) {
      this.inputPaused = false;
      this.input.resume();
    }
    if (this.inputEnded && this.buffered === 0) this._drained();
    return out;
  }

  /** Drop everything now. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.chunks = [];
    this.buffered = 0;
    try {
      if (this.input) {
        this.input.removeAllListeners('data');
        this.input.destroy?.();
      }
    } catch {
      /* ignore */
    }
    this.emit('destroyed');
  }
}

module.exports = { PcmSource };
