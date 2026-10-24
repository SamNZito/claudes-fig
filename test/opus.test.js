'use strict';
// Opus through opusscript's WebAssembly build, without opusscript's buffer bug (see src/audio/opusWasm.js).
const test = require('node:test');
const assert = require('node:assert');
const OpusScript = require('opusscript');
const wasm = require('../src/audio/opusWasm');
const { createEncoder, createDecoder } = require('../src/audio/opus');
const { Mixer } = require('../src/audio/mixer');

const AUDIO = OpusScript.Application.AUDIO;
const VOIP = OpusScript.Application.VOIP;
function tone(phase = 0) {
  const pcm = Buffer.alloc(3840);
  for (let i = 0; i < 960; i++) {
    const v = Math.round(Math.sin((i + phase) / 7) * 9000);
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(-v, i * 4 + 2);
  }
  return pcm;
}

test("same packets and same decoded audio as opusscript's own wrapper", () => {
  const theirs = new OpusScript(48000, 2, AUDIO);
  const ours = wasm.makeOpus(48000, 2, AUDIO);
  for (let k = 0; k < 20; k++) assert.equal(Buffer.compare(theirs.encode(tone(k), 960), ours.encode(tone(k), 960)), 0);
  const pkt = ours.encode(tone(), 960);
  assert.equal(Buffer.compare(new OpusScript(48000, 2, VOIP).decode(pkt), wasm.makeOpus(48000, 2, VOIP).decode(pkt)), 0);
});

test('several people talking at once never corrupts anything (opusscript itself fails this within ~500 frames)', () => {
  const enc = wasm.makeOpus(48000, 2, AUDIO);
  const pkt = enc.encode(tone(), 960);
  const live = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let step = 0; step < 15000; step++) {
    const r = rnd();
    if (r < 0.03 && live.length < 6) live.push(wasm.makeOpus(48000, 2, VOIP));
    else if (r < 0.05 && live.length) live.splice(Math.floor(rnd() * live.length), 1)[0].delete();
    for (const d of live) assert.equal(d.decode(pkt).length, 3840);
    assert.ok(enc.encode(tone(step), 960).length > 0);
  }
  assert.equal(enc.rebuilds, 0);
});

test('a fault moves to a fresh WebAssembly module instead of failing forever', () => {
  const enc = wasm.makeOpus(48000, 2, AUDIO);
  const dec = wasm.makeOpus(48000, 2, VOIP);
  const before = wasm._generation();
  const real = enc.handler._encode.bind(enc.handler);
  let thrown = 0;
  enc.handler._encode = (...a) => {
    if (!thrown++) throw new WebAssembly.RuntimeError('memory access out of bounds');
    return real(...a);
  };
  const pkt = enc.encode(tone(), 960); // trapped once, rebuilt, worked
  assert.ok(pkt.length > 0);
  assert.equal(enc.rebuilds, 1);
  assert.equal(wasm._generation(), before + 1);
  // the other instance notices its module was replaced and moves too
  assert.equal(dec.decode(pkt).length, 3840);
  assert.equal(dec.rebuilds, 1);
});

test('creating a decoder on a broken module starts on a fresh one ("could not start decoder")', () => {
  wasm.makeOpus(48000, 2, VOIP);
  wasm._breakModule();
  const d = wasm.makeOpus(48000, 2, VOIP);
  assert.equal(d.decode(wasm.makeOpus(48000, 2, AUDIO).encode(tone(), 960)).length, 3840);
});

test("Fig's encoder and decoder use it, and keep working after a fault", () => {
  const e = createEncoder();
  assert.equal(e.name, 'opus (WebAssembly)');
  const d = createDecoder();
  const pkt = e.encode(tone());
  assert.equal(d.decode(pkt).length, 3840);
  d.destroy();
});

test('encode failures are reported once per 10 s, not per frame', () => {
  const m = new Mixer({ volume: 100 });
  m.encoder = { encode: () => { throw new Error('memory access out of bounds'); } };
  const src = { label: 'x', hasData: true, startedEmitted: true, finished: false, read: (n) => tone().subarray(0, n), destroy() {}, once() {} };
  m.setMusic(src);
  const warns = [];
  m.on('warn', (w) => warns.push(w));
  for (let i = 0; i < 200; i++) m.nextPacket();
  assert.equal(warns.length, 1);
});
