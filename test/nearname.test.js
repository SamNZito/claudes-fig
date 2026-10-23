'use strict';
process.env.LOG_LEVEL = 'info'; // reads the near-miss log lines back
// "Hey, fake skip" -> skip: a word that sounds like the name, then a simple command. Nothing bigger.
const { script, fakeGuild, fakeMember } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { GuildSession } = require('../src/voice/session');
const { config } = require('../src/config');
const { ACTIVITY } = require('../src/log');
const { nearMissRest } = require('../src/brain/wake');

test('which sentences count', () => {
  assert.deepEqual(nearMissRest('Hey, fake skip.', 'fig'), { word: 'fake', rest: 'skip' });
  assert.deepEqual(nearMissRest('Hey, fix, skip.', 'fig'), { word: 'fix', rest: 'skip' });
  assert.deepEqual(nearMissRest('fick pause', 'fig'), { word: 'fick', rest: 'pause' });
  assert.equal(nearMissRest('I need to fix skip', 'fig'), null, 'not at the start');
  assert.equal(nearMissRest('hey fig skip', 'fig'), null, 'the real name is handled normally');
  assert.equal(nearMissRest('hey pig skip', 'fig'), null, 'pig does not sound like fig');
});

async function say(s, who, text) {
  script.stt.push(text);
  await s.brain._utterance({ userId: who, wav: Buffer.alloc(100), durationMs: 900 });
}

test('a misheard name plus a simple command runs the command; anything else is ignored', async () => {
  const guild = fakeGuild('near1');
  fakeMember(guild, 'cara', 'Cara', { admin: true });
  const s = new GuildSession({}, guild);
  const ran = [];
  s.brain.runFast = async (member, cmd) => ran.push(cmd);
  const grokCalls = script.calls.length;

  await say(s, 'cara', 'Hey, fake skip.');
  await say(s, 'cara', 'Hey, fix, skip.');
  await say(s, 'cara', 'yo fix turn it up');
  assert.deepEqual(ran, ['skip', 'skip', 'volup']);

  await say(s, 'cara', "Hey fake, what's the weather tomorrow?"); // not a simple command
  await say(s, 'cara', 'we should fix skip later'); // not at the start
  await say(s, 'cara', 'fake it till you make it');
  assert.deepEqual(ran, ['skip', 'skip', 'volup']);
  assert.equal(script.calls.length, grokCalls, 'none of these went to Grok');

  const logged = fs.readFileSync(ACTIVITY, 'utf8');
  assert.match(logged, /near-miss "fake" taken as "Fig" for simple command "skip": "Hey, fake skip\."/);
  assert.match(logged, /not for Fig \(mode=normal, wake name "Fig" not said\): "Hey fake, what's the weather tomorrow\?"/);
  s.destroy();
});

test('NEAR_NAME_COMMANDS=false turns it off', async () => {
  const guild = fakeGuild('near2');
  fakeMember(guild, 'dee', 'Dee', { admin: true });
  const s = new GuildSession({}, guild);
  const ran = [];
  s.brain.runFast = async (member, cmd) => ran.push(cmd);
  config.nearNameCommands = false;
  try {
    await say(s, 'dee', 'Hey, fake skip.');
  } finally {
    config.nearNameCommands = true;
  }
  assert.deepEqual(ran, []);
  s.destroy();
});
