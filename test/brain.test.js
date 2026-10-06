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

test('quiet mode ignores unnamed chatter, answers when named', async () => {
  const { s, alice } = setup('quiet');
  await s.brain.route(alice, 'play some daft punk');
  assert.strictEqual(script.calls.length, 0);
  script.chat.push({ content: 'On it.', toolCalls: [] });
  await s.brain.route(alice, 'Hey Fig, what is up?');
  assert.strictEqual(script.calls.length, 1);
  s.destroy();
});

test('normal mode: clear music ask without the name gets handled, random talk does not', async () => {
  const { s, bob } = setup('normal');
  await s.brain.route(bob, 'I think that movie was great honestly');
  assert.strictEqual(script.calls.length, 0);
  script.chat.push({ content: '', toolCalls: [] });
  await s.brain.route(bob, 'play some daft punk');
  assert.strictEqual(script.calls.length, 1);
  assert.match(script.calls[0].messages[0].content, /sounded like a music request/);
  s.destroy();
});

test('only the person who addressed Fig gets follow-ups without the name', async () => {
  const { s, alice, bob, said } = setup('normal');
  script.chat.push({ content: 'Doing great.', toolCalls: [] });
  await s.brain.route(alice, 'fig how are you');
  assert.strictEqual(said.length, 1);
  assert.strictEqual(said[0].to, 'Alice');
  s.setFocus('alice'); // respond() is stubbed, so set focus as the real one would
  script.chat.push({ content: 'Sure.', toolCalls: [] });
  await s.brain.route(alice, 'and what about you');
  assert.strictEqual(script.calls.length, 2, 'Alice follow-up handled');
  await s.brain.route(bob, 'and what about you');
  assert.strictEqual(script.calls.length, 2, 'Bob is ignored');
  s.destroy();
});

test('conversation mode needs no name', async () => {
  const { s, bob } = setup('conversation');
  script.chat.push({ content: 'hey', toolCalls: [] });
  await s.brain.route(bob, 'how is everyone doing');
  assert.strictEqual(script.calls.length, 1);
  s.destroy();
});

test('chaos mode may chime in on unaddressed talk with only stay_quiet available', async () => {
  const { s, bob, said } = setup('chaos');
  script.chat.push({ content: '', toolCalls: [toolCall('stay_quiet')] });
  await s.brain.route(bob, 'I cannot believe the ending of that show last night');
  assert.strictEqual(script.calls.length, 1);
  assert.deepStrictEqual(
    script.calls[0].tools.map((t) => t.function.name),
    ['stay_quiet'],
  );
  assert.strictEqual(said.length, 0);
  s.destroy();
});

test('fast skip happens without a model call and the song is gone', async () => {
  const { s, alice } = setup('normal');
  s.player.enqueue([
    { key: 'youtube:tone-a', id: 'tone-a', url: 'https://www.youtube.com/watch?v=tone-a', title: 'A', duration: 6, uid: 1, via: 'user' },
    { key: 'youtube:noise-b', id: 'noise-b', url: 'https://www.youtube.com/watch?v=noise-b', title: 'B', duration: 6, uid: 2, via: 'user' },
  ]);
  assert.ok(await waitFor(() => s.player.current && s.player.current.source.pcm.hasData));
  await s.brain.route(alice, 'Fig, skip.');
  assert.strictEqual(script.calls.length, 0);
  assert.strictEqual(s.player.current.entry.id, 'noise-b');
  s.destroy();
});

test('"stop" while Fig is talking stops the talking, not the music', async () => {
  const { s, alice } = setup('normal');
  s.player.enqueue([{ key: 'youtube:tone-c', id: 'tone-c', url: 'https://www.youtube.com/watch?v=tone-c', title: 'C', duration: 6, uid: 3, via: 'user' }]);
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
  s.player.enqueue([{ key: 'youtube:tone-d', id: 'tone-d', url: 'https://www.youtube.com/watch?v=tone-d', title: 'D', duration: 6, uid: 4, via: 'user' }]);
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
