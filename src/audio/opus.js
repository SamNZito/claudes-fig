'use strict';
// Opus encode/decode. Prefers the native @discordjs/opus if someone installed it, otherwise uses
// opusscript (pure WASM, installs everywhere, fast enough for one guild's worth of audio).
const { SAMPLE_RATE, CHANNELS, FRAME_SAMPLES } = require('./constants');

let native = null;
try {
  native = require('@discordjs/opus');
} catch {
  native = null;
}
const OpusScript = require('opusscript');

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
  const enc = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
  try {
    enc.encoderCTL(4002, 128000); // OPUS_SET_BITRATE
  } catch {
    /* ignore */
  }
  return { encode: (pcm) => Buffer.from(enc.encode(pcm, FRAME_SAMPLES)), name: 'opusscript', raw: enc };
}

function createDecoder() {
  if (native) {
    const dec = new native.OpusEncoder(SAMPLE_RATE, CHANNELS);
    return { decode: (packet) => dec.decode(packet), destroy() {} };
  }
  const dec = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP);
  return {
    decode: (packet) => Buffer.from(dec.decode(packet)),
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
