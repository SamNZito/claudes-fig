'use strict';
const { fakeGuild, fakeMember, script } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { onInteraction } = require('../src/discord/interactions');
const { GuildSession } = require('../src/voice/session');

function fakeInteraction(guild, member, name, opts = {}, sub = null) {
  const replies = [];
  const i = {
    commandName: name,
    guild,
    guildId: guild.id,
    channelId: 'txt',
    member,
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isRepliable: () => true,
    inCachedGuild: () => true,
    deferReply: async () => (i.deferred = true),
    reply: async (m) => {
      i.replied = true;
      replies.push(m.content);
    },
    editReply: async (m) => replies.push(typeof m === 'string' ? m : m.content),
    options: {
      getString: (k, req) => opts[k] ?? null,
      getInteger: (k) => opts[k] ?? null,
      getChannel: (k) => opts[k] ?? null,
      getUser: (k) => opts[k] ?? null,
      getRole: (k) => opts[k] ?? null,
      getAttachment: (k) => opts[k] ?? null,
      getSubcommand: () => sub,
    },
  };
  return { i, replies };
}

test('slash commands run end to end', async () => {
  const guild = fakeGuild('slash1');
  const alice = fakeMember(guild, 'alice', 'Alice', { admin: true });
  const s = new GuildSession({}, guild);
  const getSession = () => s;
  const run = async (name, opts, sub) => {
    const { i, replies } = fakeInteraction(guild, alice, name, opts, sub);
    await onInteraction(i, getSession);
    return replies.join('\n');
  };
  assert.match(await run('queue'), /Nothing playing/);
  assert.match(await run('volume', { level: 35 }), /Volume 35%/);
  assert.match(await run('mode', { mode: 'chaos' }), /Chaos mode/);
  assert.match(await run('status'), /Mode: chaos/);
  assert.match(await run('timer', { duration: '5m', label: 'tea' }), /5 minutes/);
  assert.match(await run('access', {}, 'show'), /ask\*\*: everyone/);
  assert.match(await run('personality', { preset: 'brit' }, 'preset'), /Mayo/);
  assert.match(await run('personality', {}, 'show'), /Mayo/);
  assert.match(await run('play', { query: 'x' }), /voice channel/);
  s.connection = { state: { status: 'ready' }, destroy() {} };
  assert.match(await run('play', { query: 'tone thing' }), /Loading/);
  assert.match(await run('play', { query: 'tone other' }), /Queued .* #1/);
  assert.match(await run('dj', { mood: 'chill' }, 'on'), /DJ on/);
  assert.match(await run('dj', {}, 'off'), /DJ off/);
  assert.match(await run('skip'), /Skipped/);
  assert.match(await run('pause'), /Paused/);
  assert.match(await run('resume'), /Resumed/);
  script.chat.push({ content: 'Paris.', toolCalls: [] });
  s.speak = async () => true;
  assert.match(await run('ask', { question: 'capital of France?' }), /Paris/);
  assert.match(await run('stop'), /Stopped/);
  for (const t of s.timers) clearTimeout(t);
  s.connection = null;
  s.destroy();
});
