'use strict';
// "Queueing trailer music..." with no tool call means nothing happened: Fig asks Grok again, requiring a tool.
const { script, fakeGuild, fakeMember, waitFor } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { GuildSession } = require('../src/voice/session');

function session(gid) {
  const guild = fakeGuild(gid);
  const terry = fakeMember(guild, 'terry', 'TerryDa3rd', { admin: true });
  const s = new GuildSession({}, guild);
  s.connection = { state: { status: 'ready' }, destroy() {} };
  const said = [];
  s.speak = async (t) => said.push(t);
  s.postText = (t) => said.push(t);
  return { s, terry, said };
}

test('a reply that claims to queue music without a tool call gets a second, tool-required ask, and the song is queued', async () => {
  const { s, terry } = session('claim1');
  const calls0 = script.calls.length;
  script.chat.push({ content: 'Queueing trailer music for your main-character moment.', toolCalls: [] });
  script.chat.push({ content: '', toolCalls: [{ id: 'c1', name: 'play_music', args: { query: 'Two Steps From Hell - Heart of Courage' } }] });
  await s.brain.think(terry, 'Hey Fig, can you play something that reminds me of being in a movie?', { named: true, source: 'voice' });
  const retry = script.calls[calls0 + 1];
  assert.ok(retry, 'asked Grok a second time');
  assert.equal(retry.toolChoice, 'required');
  assert.match(retry.messages[retry.messages.length - 1].content, /you called no tool, so nothing happened/);
  assert.ok(await waitFor(() => s.player.current || s.player.queue.length, 5000), 'something was actually queued');
  const e = s.player.current?.entry || s.player.queue.items[0];
  assert.equal(e.asked, 'Two Steps From Hell - Heart of Courage');
  s.connection = null;
  s.destroy();
});

test('if Grok still calls nothing, Fig says nothing was queued instead of pretending', async () => {
  const { s, terry, said } = session('claim2');
  script.chat.push({ content: "I'll put on something cinematic!", toolCalls: [] });
  script.chat.push({ content: 'Coming right up.', toolCalls: [] });
  await s.brain.think(terry, 'fig play something epic', { named: true, source: 'voice' });
  assert.ok(said.some((t) => /didn't actually queue anything/.test(t)), said.join(' | '));
  assert.ok(!said.some((t) => /cinematic/.test(t)));
  s.connection = null;
  s.destroy();
});

test('if the retry says it was only an answer (stay_quiet), the original answer stands', async () => {
  const { s, terry, said } = session('claim3');
  script.chat.push({ content: "I'll play it after this one, it's already queued for you.", toolCalls: [] });
  script.chat.push({ content: '', toolCalls: [{ id: 'q', name: 'stay_quiet', args: {} }] });
  await s.brain.think(terry, 'fig is my song coming up', { named: true, source: 'voice' });
  assert.ok(said.some((t) => /already queued for you/.test(t)), said.join(' | '));
  s.connection = null;
  s.destroy();
});

test('normal answers never trigger a second ask', async () => {
  const { s, terry } = session('claim4');
  const calls0 = script.calls.length;
  script.chat.push({ content: 'Ameno is playing right now, and the queue is empty.', toolCalls: [] });
  await s.brain.think(terry, "fig what's playing", { named: true, source: 'voice' });
  assert.equal(script.calls.length, calls0 + 1);
  s.connection = null;
  s.destroy();
});
