'use strict';
// Everything Fig hears, says and does must end up in logs/fig.log (and talk in conversation.log).
process.env.LOG_LEVEL = 'info';
const { script, fakeGuild, fakeMember, waitFor } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { GuildSession } = require('../src/voice/session');
const { onInteraction } = require('../src/discord/interactions');
const { ACTIVITY, CONVERSATION } = require('../src/log');

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

test('heard speech, decisions, actions, Grok calls and replies are all logged', async () => {
  const guild = fakeGuild('logs1');
  const alice = fakeMember(guild, 'alice', 'Alice', { admin: true });
  const s = new GuildSession({}, guild);
  // Something said without the name, then a named command.
  script.stt.push('so anyway that game was wild');
  await s.brain._utterance({ userId: 'alice', wav: Buffer.alloc(100), durationMs: 1200 });
  script.stt.push('hey fig pause');
  await s.brain._utterance({ userId: 'alice', wav: Buffer.alloc(100), durationMs: 900 });
  script.stt.push('fig what is the capital of france');
  script.chat.push({ content: 'Paris.', toolCalls: [] });
  await s.brain._utterance({ userId: 'alice', wav: Buffer.alloc(100), durationMs: 1500 });

  // A slash command and its reply.
  const replies = [];
  const i = {
    commandName: 'volume',
    guild,
    guildId: guild.id,
    channelId: 'txt',
    channel: { name: 'general' },
    member: alice,
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isRepliable: () => true,
    inCachedGuild: () => true,
    deferReply: async () => {},
    reply: async (m) => replies.push(m.content),
    editReply: async (m) => replies.push(m.content),
    options: { data: [{ name: 'level', value: 33 }], getInteger: () => 33, getString: () => null },
  };
  await onInteraction(i, () => s);

  await waitFor(() => /Paris/.test(read(CONVERSATION)));
  const talk = read(CONVERSATION);
  const all = read(ACTIVITY);
  assert.match(talk, /HEARD  Alice: so anyway that game was wild/);
  assert.match(all, /not for Fig \(mode=normal/);
  assert.match(talk, /HEARD  Alice: hey fig pause/);
  assert.match(all, /\[action\] pause\(/, 'actions are traced');
  assert.match(all, /asking Grok for Alice/);
  assert.match(talk, /Paris/, 'what Fig answered is logged');
  assert.match(talk, /SLASH  Alice: \/volume level=33/);
  assert.match(talk, /REPLY  Fig → Alice: Volume 33%/);
  assert.match(all, /\[action\] volume\(.*"level":33/);
  assert.match(all, / [a-z0-9-]+:\d+ \[/i, 'every line says which copy (host:pid) wrote it');
  s.destroy();
});
