'use strict';
// Opus encode/decode. Prefers the native @discordjs/opus if it installed, otherwise opusscript's
// WebAssembly build through our own wrapper (opusWasm.js): opusscript's own JS wrapper writes outside
// its buffers and corrupts itself when several people talk at once.
const { SAMPLE_RATE, CHANNELS, FRAME_SAMPLES } = require('./constants');

let native = null;
try {
  native = require('@discordjs/opus');
} catch {
  native = null;
}
const OpusScript = require('opusscript'); // only for its constants; never `new OpusScript()`
const { makeOpus } = require('./opusWasm');

function createEncoder() {
  if (native) {
    const enc = new native.OpusEncoder(SAMPLE_RATE, CHANNELS);
    try {
      enc.setBitrate(128000);
    } catch {
      /* ignore */
    }
    return { encode: (pcm) => enc.encode(pcm), name: '@discordjs/opus' };
  }
  const enc = makeOpus(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
  const bitrate = () => {
    try {
      enc.encoderCTL(4002, 128000); // OPUS_SET_BITRATE
    } catch {
      /* ignore */
    }
  };
  bitrate();
  let rebuilds = 0;
  return {
    encode: (pcm) => {
      const out = enc.encode(pcm, FRAME_SAMPLES);
      if (enc.rebuilds !== rebuilds) {
        rebuilds = enc.rebuilds; // moved to a fresh WebAssembly module after a fault: set the bitrate again
        bitrate();
      }
      return out;
    },
    name: 'opus (WebAssembly)',
    raw: enc,
  };
}

function createDecoder() {
  if (native) {
    const dec = new native.OpusEncoder(SAMPLE_RATE, CHANNELS);
    return { decode: (packet) => dec.decode(packet), destroy() {} };
  }
  const dec = makeOpus(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP);
  return {
    decode: (packet) => dec.decode(packet),
    destroy: () => {
      try {
        dec.delete();
      } catch {
        /* ignore */
      }
    },
  };
}

module.exports = { createEncoder, createDecoder, usingNative: () => Boolean(native) };
