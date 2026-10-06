'use strict';
// Slash command handling. Every command maps onto src/actions.js (same code as voice commands).
const { MessageFlags } = require('discord.js');
const actions = require('../actions');
const grok = require('../brain/grok');
const personalities = require('../brain/personalities');
const { CAPS, isAdmin, setRoles } = require('./permissions');
const store = require('../store');
const log = require('../log').logger('slash');

// Commands whose result Fig also says out loud in the call.
const SPOKEN = new Set(['say', 'look', 'factcheck', 'status']);
// Slow commands: acknowledge first.
const SLOW = new Set(['play', 'join', 'dj', 'personality', 'voice', 'look', 'factcheck', 'ask', 'mod']);

async function handleAutocomplete(interaction) {
  if (interaction.commandName === 'voice') {
    const focused = String(interaction.options.getFocused() || '').toLowerCase();
    const voices = personalities.VOICES.filter((v) => v.id.includes(focused) || v.name.toLowerCase().includes(focused));
    await interaction.respond(voices.slice(0, 25).map((v) => ({ name: `${v.name} — ${v.tone}`.slice(0, 100), value: v.id })));
  }
}

async function handleCommand(interaction, getSession) {
  if (!interaction.inCachedGuild()) {
    return interaction.reply({ content: 'Fig only works inside a server.', flags: MessageFlags.Ephemeral });
  }
  const session = getSession(interaction.guild);
  session.lastTextChannelId = interaction.channelId;
  const member = interaction.member;
  const ctx = session.ctx(member, 'slash');
  const name = interaction.commandName;
  const o = interaction.options;

  if (SLOW.has(name)) await interaction.deferReply();
  const send = async (content, { ephemeral = false } = {}) => {
    const text = String(content || 'Done.').slice(0, 1990);
    if (interaction.deferred || interaction.replied) return interaction.editReply({ content: text, allowedMentions: { parse: [] } });
    return interaction.reply({ content: text, allowedMentions: { parse: [] }, flags: ephemeral ? MessageFlags.Ephemeral : undefined });
  };

  let r;
  switch (name) {
    case 'join':
      r = await actions.join(ctx, o.getChannel('channel') || undefined);
      break;
    case 'leave':
      r = await actions.leave(ctx);
      break;
    case 'play':
      r = await actions.play(ctx, { query: o.getString('query', true), when: o.getString('when') || 'queue' });
      break;
    case 'skip':
      r = actions.skip(ctx);
      break;
    case 'remove':
      r = actions.remove(ctx, { which: o.getString('which', true) });
      break;
    case 'pause':
      r = actions.pause(ctx);
      break;
    case 'resume':
      r = actions.resume(ctx);
      break;
    case 'stop':
      r = actions.stop(ctx);
      break;
    case 'clear':
      r = actions.clear(ctx);
      break;
    case 'shuffle':
      r = actions.shuffle(ctx);
      break;
    case 'queue':
      r = actions.queue(ctx);
      break;
    case 'nowplaying':
      r = actions.nowPlaying(ctx);
      break;
    case 'volume': {
      const level = o.getInteger('level');
      r = actions.volume(ctx, level === null ? {} : { level });
      break;
    }
    case 'dj': {
      const sub = o.getSubcommand();
      r = await actions.dj(ctx, { action: sub === 'off' ? 'off' : 'on', mood: o.getString('mood') || undefined });
      break;
    }
    case 'mode':
      r = actions.setMode(ctx, { mode: o.getString('mode', true) });
      break;
    case 'name':
      r = actions.setName(ctx, { name: o.getString('name', true) });
      break;
    case 'personality': {
      const sub = o.getSubcommand();
      if (sub === 'show') {
        const p = personalities.resolve(store.settings(interaction.guildId).personality);
        r = { ok: true, text: `**${p.label}**\n> ${p.prompt}` };
      } else if (sub === 'custom') r = await actions.setPersonality(ctx, { description: o.getString('description', true) });
      else r = await actions.setPersonality(ctx, { preset: o.getString('preset', true) });
      break;
    }
    case 'voice': {
      if (o.getSubcommand() === 'list') {
        const current = store.settings(interaction.guildId).voice;
        const lines = personalities.VOICES.map((v) => `${v.id === current ? '**' : ''}${v.name}${v.id === current ? '**' : ''} — ${v.tone}`);
        r = { ok: true, text: `${lines.join('\n')}\n\nCurrent: **${personalities.voiceLabel(current)}**` };
      } else {
        r = await actions.setVoice(ctx, { voice: o.getString('voice', true) });
        if (r.ok && session.connection) session.speak(r.say);
        r = { ...r, say: null, text: r.text || r.say };
      }
      break;
    }
    case 'say':
      if (!session.connection) {
        r = { ok: false, say: "I'm not in a voice channel. /join first." };
        break;
      }
      r = actions.sayLine(ctx, { text: o.getString('text', true) });
      break;
    case 'shutup':
      r = actions.shutUp(ctx);
      break;
    case 'forget':
      r = actions.forget(ctx);
      break;
    case 'status':
      r = actions.status(ctx);
      break;
    case 'timer': {
      const secs = actions.parseDuration(o.getString('duration', true));
      r = actions.timer(ctx, { seconds: secs, label: o.getString('label') || undefined });
      break;
    }
    case 'ask': {
      const q = o.getString('question', true);
      await session.brain.handleText(member, q, { reply: (c) => send(`> ${q}\n${c}`) });
      return;
    }
    case 'look': {
      const att = o.getAttachment('image', true);
      if (!String(att.contentType || '').startsWith('image/')) {
        r = { ok: false, say: "That doesn't look like an image." };
        break;
      }
      r = await actions.look(ctx, { question: o.getString('question') || 'What do you see?', image: { url: att.url, contentType: att.contentType } });
      break;
    }
    case 'factcheck':
      r = await actions.factCheck(ctx);
      break;
    case 'mod': {
      const user = o.getUser('user', true);
      const target = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!target) {
        r = { ok: false, say: "That person isn't in this server." };
        break;
      }
      r = await actions.moderate(ctx, { action: o.getString('action', true), person: target, minutes: o.getInteger('minutes') || 5, reason: o.getString('reason') || '' });
      break;
    }
    case 'access': {
      if (!isAdmin(member)) {
        r = { ok: false, say: 'You need Manage Server to change access.' };
        break;
      }
      const sub = o.getSubcommand();
      const acc = store.settings(interaction.guildId).access;
      if (sub === 'show') {
        const line = (c) => `**${c}**: ${acc[c]?.length ? acc[c].map((id) => `<@&${id}>`).join(', ') : 'everyone'}`;
        r = { ok: true, text: CAPS.map(line).join('\n') + '\n(People with Manage Server can always do everything.)' };
        break;
      }
      const capName = o.getString('capability', true);
      const role = o.getRole('role');
      let list = [...(acc[capName] || [])];
      if (sub === 'allow') list.push(role.id);
      if (sub === 'disallow') list = list.filter((id) => id !== role.id);
      if (sub === 'reset') list = [];
      const now = setRoles(interaction.guildId, capName, list);
      r = { ok: true, text: `**${capName}** is now limited to: ${now.length ? now.map((id) => `<@&${id}>`).join(', ') : 'everyone'}.` };
      break;
    }
    default:
      r = { ok: false, say: 'Unknown command.' };
  }

  const text = r.text || r.say || (r.ok ? 'Done.' : 'That did not work.');
  await send(text, { ephemeral: !r.ok && !interaction.deferred });
  if (r.say && SPOKEN.has(name) && session.connection) session.speak(r.say);
}

async function onInteraction(interaction, getSession) {
  try {
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);
    if (!interaction.isChatInputCommand()) return;
    await handleCommand(interaction, getSession);
  } catch (e) {
    log.error(`command /${interaction.commandName} failed:`, e);
    try {
      const msg = { content: 'Something went wrong with that command.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: msg.content });
      else if (interaction.isRepliable()) await interaction.reply(msg);
    } catch {
      /* ignore */
    }
  }
}

module.exports = { onInteraction };
