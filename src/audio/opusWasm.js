'use strict';
// A correct wrapper around opusscript's WebAssembly Opus build.
//
// Why not `new OpusScript()`: opusscript 0.1.x mallocs its PCM buffers by BYTE address but then views
// them through HEAPU16 at that same number, which is an ELEMENT index. The view starts at twice the
// allocated address. Every encode/decode writes ~23 KB into memory that belongs to something else.
// With one decoder that lands somewhere harmless; with several people talking at once, one decoder
// overwrites another decoder's (or the encoder's) state, libopus aborts or traps with "memory access
// out of bounds", and from then on everything in that WebAssembly instance fails (Oct 24: three
// speakers within 2 s, then "could not start decoder" and "opus encode failed" on every frame).
//
// This uses the same compiled module and the same data layout (one byte per 16-bit slot, which is
// what the C side expects), but at the address that was actually allocated, sized for it. If the
// module ever traps anyway, the instance is rebuilt on a brand-new module, so a fault can't spread.
const factory = require('opusscript/build/opusscript_native_wasm.js');

const MAX_FRAME_SIZE = (48000 * 60) / 1000; // samples per channel in the longest Opus frame
const MAX_PACKET_SIZE = 1276 * 3;
const ERRORS = { '-1': 'Bad argument', '-2': 'Buffer too small', '-3': 'Internal error', '-4': 'Invalid packet', '-5': 'Unimplemented', '-6': 'Invalid state', '-7': 'Memory allocation fail' };

let mod = null;
let generation = 0;
function module_() {
  if (!mod) {
    mod = factory();
    generation++;
  }
  return mod;
}
/** Throw away a module that trapped: its memory can't be trusted any more. */
function discardModule(m) {
  if (mod === m) mod = null;
}

const isTrap = (e) => /memory access out of bounds|Aborted|unreachable|RuntimeError/i.test(String(e?.message || e));

class SafeOpus {
  constructor(samplingRate, channels, application) {
    this.args = [samplingRate, channels || 1, application];
    this.channels = channels || 1;
    this.rebuilds = 0;
    try {
      this._init();
    } catch (e) {
      // The shared module may already be broken by an older instance: start on a fresh one.
      if (!isTrap(e)) throw e;
      discardModule(this.m || mod);
      this._init();
    }
  }

  _init() {
    const m = module_();
    this.m = m;
    if (m.__figBroken) throw new Error('memory access out of bounds (module marked broken)');
    this.gen = generation;
    this.handler = new m.OpusScriptHandler(...this.args);
    this.pcmSlots = MAX_FRAME_SIZE * this.channels * 2; // one 16-bit slot per PCM byte
    this.inPcm = m._malloc(this.pcmSlots * 2);
    this.outPcm = m._malloc(this.pcmSlots * 2);
    this.inPkt = m._malloc(MAX_PACKET_SIZE);
    this.outPkt = m._malloc(MAX_PACKET_SIZE);
    if (!this.inPcm || !this.outPcm || !this.inPkt || !this.outPkt) throw new Error('opus: out of memory');
    if (this.inPcm % 2 || this.outPcm % 2) throw new Error('opus: unaligned buffer');
  }

  /** Run fn; on a WebAssembly trap, move this instance to a fresh module and try once more. */
  _guard(fn) {
    if (this.gen !== generation || this.m !== mod) this._rebuild(); // another instance found the module broken
    try {
      return fn();
    } catch (e) {
      if (!isTrap(e)) throw e;
      discardModule(this.m);
      this._rebuild();
      return fn();
    }
  }

  _rebuild() {
    this.rebuilds++;
    this._init();
  }

  encode(pcm, frameSize) {
    if (pcm.length > this.pcmSlots) throw new RangeError(`opus: ${pcm.length} bytes of PCM is more than one frame`);
    return this._guard(() => {
      const m = this.m;
      m.HEAPU16.set(pcm, this.inPcm >> 1); // each byte into its own 16-bit slot, at the allocated address
      const len = this.handler._encode(this.inPcm, pcm.length, this.outPkt, frameSize);
      if (len < 0) throw new Error(`Encode error: ${ERRORS[len] || len}`);
      return Buffer.from(m.HEAPU8.subarray(this.outPkt, this.outPkt + len));
    });
  }

  decode(packet) {
    if (packet.length > MAX_PACKET_SIZE) throw new RangeError(`opus: ${packet.length}-byte packet is too big`);
    return this._guard(() => {
      const m = this.m;
      m.HEAPU8.set(packet, this.inPkt);
      const len = this.handler._decode(this.inPkt, packet.length, this.outPcm);
      if (len < 0) throw new Error(`Decode error: ${ERRORS[len] || len}`);
      const slots = len * this.channels * 2;
      return Buffer.from(m.HEAPU16.subarray(this.outPcm >> 1, (this.outPcm >> 1) + slots)); // slots -> bytes
    });
  }

  encoderCTL(ctl, arg) {
    return this._guard(() => {
      const r = this.handler._encoder_ctl(ctl, arg);
      if (r < 0) throw new Error(`Encoder CTL error: ${ERRORS[r] || r}`);
    });
  }

  delete() {
    if (this.m !== mod) return; // its module was discarded; nothing to free
    try {
      this.m.OpusScriptHandler.destroy_handler(this.handler);
      for (const p of [this.inPcm, this.outPcm, this.inPkt, this.outPkt]) this.m._free(p);
    } catch {
      /* a broken module: it will be replaced */
    }
  }
}

module.exports = {
  SafeOpus,
  makeOpus: (rate, channels, app) => new SafeOpus(rate, channels, app),
  isTrap,
  MAX_PACKET_SIZE,
  // tests: pretend the current module was corrupted
  _breakModule: () => mod && (mod.__figBroken = true),
  _generation: () => generation,
};
