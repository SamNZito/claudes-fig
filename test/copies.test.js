'use strict';
// Detecting another program on the bot token from messages it posts (works across machines).
const test = require('node:test');
const assert = require('node:assert');
const { CopyWatch } = require('../src/util/copyWatch');

test('a message this copy sent is ours; one it never sent is another copy', async () => {
  const w = new CopyWatch();
  // Ours: the send resolves after the gateway already delivered the message.
  let resolveSend;
  const sent = w.track(new Promise((r) => (resolveSend = r)));
  const check = w.checkOwnMessage({ id: 'm1', content: 'Now playing: X' }, { graceMs: 30 });
  setTimeout(() => resolveSend({ id: 'm1' }), 60);
  await sent;
  assert.equal(await check, false);
  assert.equal(w.snapshot().total, 0);

  // Not ours.
  assert.equal(await w.checkOwnMessage({ id: 'm2', content: 'Now playing: Let Go', channel: { name: 'zzzz' } }, { graceMs: 10 }), true);
  const snap = w.snapshot();
  assert.equal(snap.signals.message, 1);
  assert.match(snap.last.detail, /Now playing: Let Go.*#zzzz/);
});

test('slash-command replies are matched by the command this copy handled', async () => {
  const w = new CopyWatch();
  w.noteInteraction('i1');
  assert.equal(await w.checkOwnMessage({ id: 'r1', interactionMetadata: { id: 'i1' } }, { graceMs: 5 }), false);
  assert.equal(await w.checkOwnMessage({ id: 'r2', interactionMetadata: { id: 'i9' }, interaction: { commandName: 'play' } }, { graceMs: 5 }), true);
  assert.equal(w.snapshot().signals.message, 1);
});

test('the chat warning says which copy is talking and is not repeated within 10 minutes', () => {
  const w = new CopyWatch();
  const posted = [];
  const session = { guild: { id: 'g' }, postText: (t) => posted.push(t) };
  const e = w.report('message', 'posted "x" and this copy did not');
  w.warnInChat(session, e);
  w.warnInChat(session, e);
  assert.equal(posted.length, 1);
  assert.match(posted[0], /This is .* pid \d+/);
});
