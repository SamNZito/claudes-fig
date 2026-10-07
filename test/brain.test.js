'use strict';
const { script, fakeGuild, fakeMember, waitFor, sleep } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { GuildSession } = require('../src/voice/session');
const store = require('../src/store');
const { fastCommand } = require('../src/brain/brain');
const { PcmSource } = require('../src/audio/pcmSource');

function setup(mode = 'normal', gid = `g-${Math.random()}`) {
  const guild = fakeGuild(gid);
  const alice = fakeMember(guild, 'alice', 'Alice', { admin: true });
  const bob = fakeMember(guild, 'bob', 'Bob');
  const s = new GuildSession({}, guild);
  store.updateSettings(gid, { mode });
  const said = [];
  s.respond = async ({ member, text }) => {
    said.push({ to: member?.displayName, text });
  };
  script.chat = [];
  script.calls = [];
  return { s, alice, bob, said, gid };
}
const toolCall = (name, args = {}) => ({ id: name, name, args });

test('fast commands parse', () => {
  assert.strictEqual(fastCommand('skip'), 'skip');
  assert.strictEqual(fastCommand('skip this song please'), 'skip');
  assert.strictEqual(fastCommand('Pause.'), 'pause');
  assert.strictEqual(fastCommand('turn it down'), 'voldown');
  assert.strictEqual(fastCommand('volume 30'), 'volset');
  assert.strictEqual(fastCommand('stop talking'), 'shutup');
  assert.strictEqual(fastCommand('play some jazz'), null);
});

test('normal mode: nothing happens without the wake name, even a music request', async () => {
  const { s, alice } = setup('normal');
  await s.brain.route(alice, 'play some daft punk');
  await s.brain.route(alice, 'skip this song');
  assert.strictEqual(script.calls.length, 0);
  script.chat.push({ content: 'On it.', toolCalls: [] });
  await s.brain.route(alice, 'Hey Fig, what is up?');
  assert.strictEqual(script.calls.length, 1);
  s.destroy();
});

test('normal mode: no follow-ups without the name, even right after Fig answered', async () => {
  const { s, alice, said } = setup('normal');
  script.chat.push({ content: 'Doing great.', toolCalls: [] });
  await s.brain.route(alice, 'fig how are you');
  assert.strictEqual(said.length, 1);
  assert.strictEqual(said[0].to, 'Alice');
  s.setFocus('alice');
  await s.brain.route(alice, 'and what about you');
  assert.strictEqual(script.calls.length, 1, 'follow-up without the name is ignored');
  s.destroy();
});

test('conversation mode needs no name', async () => {
  const { s, bob } = setup('conversation');
  script.chat.push({ content: 'hey', toolCalls: [] });
  await s.brain.route(bob, 'how is everyone doing');
  assert.strictEqual(script.calls.length, 1);
  s.destroy();
});

test('conversation mode: fast commands work without the name', async () => {
  const { s, bob } = setup('conversation');
  s.player.enqueue([{ key: 'soundcloud:tone-cv', id: 'tone-cv', url: 'https://soundcloud.com/fake/tone-cv', title: 'CV', duration: 6, via: 'user' }]);
  assert.ok(await waitFor(() => s.player.current?.source?.pcm.hasData));
  await s.brain.route(bob, 'pause');
  assert.strictEqual(s.player.paused, true);
  assert.strictEqual(script.calls.length, 0);
  s.destroy();
});

test('every new call starts in normal mode', () => {
  const { s, gid } = setup('conversation');
  assert.strictEqual(store.settings(gid).mode, 'conversation');
  s.startNewCall();
  assert.strictEqual(store.settings(gid).mode, 'normal');
  s.destroy();
});

test('only two modes exist; old saved modes become normal', () => {
  const { MODES } = require('../src/config');
  assert.deepStrictEqual([...MODES].sort(), ['conversation', 'normal']);
  const gid = `old-${Math.random()}`;
  store.updateSettings(gid, { mode: 'chaos' });
  assert.strictEqual(store.settings(gid).mode, 'normal');
});

test('fast skip happens without a model call and the song is gone', async () => {
  const { s, alice } = setup('normal');
  s.player.enqueue([
    { key: 'soundcloud:tone-a', id: 'tone-a', url: 'https://soundcloud.com/fake/tone-a', title: 'A', duration: 6, uid: 1, via: 'user' },
    { key: 'soundcloud:noise-b', id: 'noise-b', url: 'https://soundcloud.com/fake/noise-b', title: 'B', duration: 6, uid: 2, via: 'user' },
  ]);
  assert.ok(await waitFor(() => s.player.current?.source?.pcm.hasData));
  await s.brain.route(alice, 'Fig, skip.');
  assert.strictEqual(script.calls.length, 0);
  assert.strictEqual(s.player.current.entry.id, 'noise-b');
  s.destroy();
});

test('"stop" while Fig is talking stops the talking, not the music', async () => {
  const { s, alice } = setup('normal');
  s.player.enqueue([{ key: 'soundcloud:tone-c', id: 'tone-c', url: 'https://soundcloud.com/fake/tone-c', title: 'C', duration: 6, uid: 3, via: 'user' }]);
  assert.ok(await waitFor(() => s.player.current));
  const clip = new PcmSource();
  clip.push(Buffer.alloc(3840 * 100));
  clip.end();
  s.mixer.addVoice(clip);
  await s.brain.route(alice, 'fig stop');
  assert.strictEqual(s.mixer.voiceActive, false);
  assert.ok(s.player.current, 'music keeps going');
  s.destroy();
});

test('failed tool beats the model claiming success', async () => {
  const { s, alice, said } = setup('normal');
  script.chat.push({ content: 'Done, removed it!', toolCalls: [toolCall('remove_song', { which: 'nonexistent song' })] });
  await s.brain.route(alice, 'fig remove nonexistent song from the queue');
  assert.strictEqual(said.length, 1);
  assert.match(said[0].text, /couldn't find/);
  s.destroy();
});

test('play when idle: music is the confirmation, nothing claimed', async () => {
  const { s, alice, said } = setup('normal');
  s.connection = null;
  // The play action needs voice; pretend we are connected.
  s.connection = { state: { status: 'ready' }, destroy() {} };
  script.chat.push({ content: '', toolCalls: [toolCall('play_music', { query: 'tone song' })] });
  await s.brain.route(alice, 'fig play tone song');
  assert.strictEqual(said.length, 0);
  assert.ok(await waitFor(() => s.player.current));
  s.connection = null;
  s.destroy();
});

test('role limits: without the control role you cannot skip', async () => {
  const { s, bob, gid, said } = setup('normal');
  store.updateSettings(gid, { access: { control: ['djrole'] } });
  s.player.enqueue([{ key: 'soundcloud:tone-d', id: 'tone-d', url: 'https://soundcloud.com/fake/tone-d', title: 'D', duration: 6, uid: 4, via: 'user' }]);
  assert.ok(await waitFor(() => s.player.current));
  await s.brain.route(bob, 'fig skip');
  assert.strictEqual(s.player.current.entry.id, 'tone-d');
  assert.match(said[0].text, /not allowed/);
  s.destroy();
});

test('voice ban needs a spoken yes', async () => {
  const { s, alice, bob, said } = setup('normal');
  let banned = null;
  s.guild.members.me = { id: 'fig', permissions: { has: () => true } };
  s.guild.members.ban = async (m) => (banned = m.id);
  bob.bannable = true;
  s.guild.channels.cache.set('vc', { id: 'vc', members: new Map([['bob', bob]]) });
  s.voiceChannelId = 'vc';
  script.chat.push({ content: '', toolCalls: [toolCall('moderate', { action: 'ban', person: 'bob' })] });
  await s.brain.route(alice, 'fig ban bob');
  assert.strictEqual(banned, null);
  assert.match(said[0].text, /Say yes/);
  await s.brain.route(alice, 'yes');
  assert.strictEqual(banned, 'bob');
  s.voiceChannelId = null;
  s.destroy();
});

test('timer is announced', async () => {
  const { s, alice, said } = setup('normal');
  const actions = require('../src/actions');
  const r = actions.timer(s.ctx(alice), { seconds: 1, label: 'pizza' });
  assert.ok(r.ok);
  await sleep(1200);
  assert.match(said[0].text, /pizza timer is done/);
  s.destroy();
});
