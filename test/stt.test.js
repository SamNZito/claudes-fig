'use strict';
// Speech-to-text request: xAI only reads the options when they come before the audio.
const test = require('node:test');
const assert = require('node:assert');
const { sttForm } = require('../src/brain/grok');
const { sttKeyterms } = require('../src/brain/wake');

test('the audio is the last field; model, language and keyterms come first', () => {
  const form = sttForm(Buffer.from('RIFF'), { keyterms: ['Fig', 'Hey Fig', 'skip'], language: 'en', model: 'grok-voice-transcribe-2.0' });
  const fields = [...form.keys()];
  assert.equal(fields[fields.length - 1], 'file');
  assert.deepEqual(fields.slice(0, -1), ['model', 'language', 'keyterm', 'keyterm', 'keyterm']);
  assert.deepEqual(form.getAll('keyterm'), ['Fig', 'Hey Fig', 'skip']);
  // the fallback field name is also last
  const alt = [...sttForm(Buffer.from('x'), { field: 'audio', keyterms: [] }).keys()];
  assert.equal(alt[alt.length - 1], 'audio');
});

test('keyterms are de-duplicated, trimmed to 50 characters, and capped at 100', () => {
  const many = Array.from({ length: 150 }, (_, i) => `term ${i}`);
  const form = sttForm(Buffer.from('x'), { keyterms: ['Fig', 'fig', ' ', 'x'.repeat(80), ...many] });
  const k = form.getAll('keyterm');
  assert.equal(k.length, 100);
  assert.equal(k.filter((t) => t.toLowerCase() === 'fig').length, 1);
  assert.equal(k[1].length, 50);
});

test("Fig's hints: the name with greetings, and the short commands", () => {
  const k = sttKeyterms('fig', ['Super Chill']);
  for (const t of ['Fig', 'Hey Fig', 'Okay Fig', 'skip', 'pause', 'resume', 'volume', 'Super Chill']) assert.ok(k.includes(t), t);
});
