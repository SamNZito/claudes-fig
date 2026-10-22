'use strict';
// Music goes down once while Fig answers a spoken request, and comes back once (no down-up-down).
const { script, fakeGuild, fakeMember, sleep } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { Mixer } = require('../src/audio/mixer');
const { GuildSession } = require('../src/voice/session');

test('the music stays down for the whole answer, even when Grok takes longer than 1.5 s', async () => {
  const guild = fakeGuild('duck1');
  const alice = fakeMember(guild, 'alice', 'Alice');
  const s = new GuildSession({}, guild);
  s.connection = { state: { status: 'ready' }, destroy() {} };
  let heldWhileThinking = null;
  let heldWhileSpeaking = null;
  s.speak = async () => {
    heldWhileSpeaking = s.mixer.heldDucked();
    return true;
  };
  script.chat.push(async () => {
    await sleep(1800); // longer than the old fixed 1.5 s hold
    heldWhileThinking = s.mixer.heldDucked();
    return { content: 'Sure thing.', toolCalls: [] };
  });
  await s.brain.think(alice, 'what time is it', { named: true, source: 'voice' });
  assert.equal(heldWhileThinking, true, 'still ducked after 1.8 s of thinking');
  assert.equal(heldWhileSpeaking, true, 'still ducked when the answer starts');
  assert.equal(s.mixer.heldDucked(), false, 'released once the answer is done');
  s.connection = null;
  s.destroy();
});

test('typed requests (/ask, mentions) do not duck the music', async () => {
  const guild = fakeGuild('duck2');
  const alice = fakeMember(guild, 'alice', 'Alice');
  const s = new GuildSession({}, guild);
  let held = null;
  script.chat.push(async () => {
    held = s.mixer.heldDucked();
    return { content: 'Hi.', toolCalls: [] };
  });
  await s.brain.think(alice, 'hi', { named: true, source: 'text', reply: async () => {} });
  assert.equal(held, false);
  s.destroy();
});

test('a hold that is never released still ends at its safety limit', async () => {
  const m = new Mixer({ volume: 100 });
  m.duckFor('test', 50);
  assert.equal(m.heldDucked(), true);
  await sleep(80);
  assert.equal(m.heldDucked(), false);
  // and the gain actually goes down and comes back
  const release = m.duckFor('test');
  for (let i = 0; i < 20; i++) m.nextFrame();
  assert.equal(m.duckGain, m.duckLevel);
  release();
  for (let i = 0; i < 40; i++) m.nextFrame();
  assert.equal(m.duckGain, 1);
});
