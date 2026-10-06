'use strict';
// Fig entry point.
const { Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits, ChannelType, OAuth2Scopes } = require('discord.js');
const { generateDependencyReport } = require('@discordjs/voice');
const { config, validateConfig } = require('./config');
const { GuildSession, humanMembers } = require('./voice/session');
const { commands } = require('./discord/commands');
const { onInteraction } = require('./discord/interactions');
const store = require('./store');
const log = require('./log').logger('fig');
const crash = require('./crashlog');

crash.noteIfPreviousDied();
crash.note('process started');
setInterval(() => crash.beat(), 20000).unref();

const problems = validateConfig();
if (problems.length) {
  log.error(`Config problems:\n  - ${problems.join('\n  - ')}\nCopy .env.example to .env and fill it in.`);
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel],
});

const sessions = new Map();
function getSession(guild) {
  let s = sessions.get(guild.id);
  if (!s) {
    s = new GuildSession(client, guild);
    s.on('leftEmpty', () => autoJoinBusiest(guild).catch(() => {}));
    sessions.set(guild.id, s);
  }
  return s;
}

function guildAllowed(guild) {
  return !config.guildIds.length || config.guildIds.includes(guild.id);
}

async function registerCommands(guild) {
  try {
    await guild.commands.set(commands);
    log.info(`registered ${commands.length} slash commands in ${guild.name}`);
  } catch (e) {
    log.warn(`could not register commands in ${guild.name}: ${e.message}`);
  }
}

function humans(channel) {
  return humanMembers(channel);
}

function canJoin(channel) {
  const perms = channel.permissionsFor(channel.guild.members.me);
  return Boolean(perms?.has(PermissionFlagsBits.Connect) && perms?.has(PermissionFlagsBits.Speak) && channel.joinable);
}

/** Join where people are (used at startup). */
async function autoJoinBusiest(guild) {
  if (!config.autoJoin) return;
  const s = getSession(guild);
  if (s.connection) return;
  const channels = guild.channels.cache
    .filter((c) => (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice) && c.id !== guild.afkChannelId)
    .filter((c) => humans(c).length > 0 && canJoin(c))
    .sort((a, b) => humans(b).length - humans(a).length);
  const target = channels.first();
  const summary = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)
    .map((c) => `#${c.name}:${humans(c).length}`)
    .join(', ');
  if (target) {
    log.info(`auto-join ${guild.name} -> #${target.name} (${humans(target).length} people). channels: ${summary || 'none'}`);
    try {
      await s.join(target);
      crash.note(`joined #${target.name} in ${guild.name}`);
    } catch (e) {
      log.warn(`auto-join failed: ${e.message}`);
      crash.note(`auto-join failed in ${guild.name}: ${e.message}`);
    }
  } else {
    log.info(`auto-join ${guild.name}: nobody to join. channels: ${summary || 'none cached'}`);
  }
}

client.once(Events.ClientReady, async (c) => {
  clearTimeout(loginTimer);
  log.info(`logged in as ${c.user.tag}`);
  crash.note(`logged in as ${c.user.tag}`);
  log.info(`voice dependencies:\n${generateDependencyReport()}`);
  const invite = c.generateInvite({
    scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
    permissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.Connect,
      PermissionFlagsBits.Speak,
      PermissionFlagsBits.UseVAD,
      PermissionFlagsBits.KickMembers,
      PermissionFlagsBits.BanMembers,
      PermissionFlagsBits.ModerateMembers,
      PermissionFlagsBits.MuteMembers,
      PermissionFlagsBits.MoveMembers,
    ],
  });
  log.info(`invite link: ${invite}`);
  for (const guild of c.guilds.cache.values()) {
    if (!guildAllowed(guild)) continue;
    await registerCommands(guild);
    await autoJoinBusiest(guild);
  }
  // Voice state sometimes is not in the cache on the ready event. Look again once.
  setTimeout(() => {
    for (const guild of c.guilds.cache.values()) {
      if (!guildAllowed(guild)) continue;
      autoJoinBusiest(guild).catch((e) => log.warn(`auto-join retry failed: ${e.message}`));
    }
  }, 4000).unref?.();
});

client.on(Events.GuildCreate, async (guild) => {
  if (!guildAllowed(guild)) return;
  await registerCommands(guild);
  await autoJoinBusiest(guild);
});

client.on(Events.InteractionCreate, (i) => {
  if (i.guild && !guildAllowed(i.guild)) return;
  onInteraction(i, getSession);
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild;
  if (!guildAllowed(guild)) return;
  const s = getSession(guild);

  // Fig's own voice state.
  if (newState.id === client.user.id) {
    if (oldState.channelId && !newState.channelId) s.onForcedDisconnect();
    else if (newState.channelId && oldState.channelId && newState.channelId !== oldState.channelId) s.onMoved(newState.channelId);
    return;
  }
  if (newState.member?.user.bot) return;

  // After "leave", allow auto-join again once that channel empties out.
  if (s.suppressAutoJoinChannel) {
    const ch = guild.channels.cache.get(s.suppressAutoJoinChannel);
    if (!ch || humans(ch).length === 0) s.suppressAutoJoinChannel = null;
  }

  if (s.connection || s.wantConnected) {
    s.checkEmpty();
    return;
  }

  // Not in voice: follow people into a channel.
  if (config.autoJoin && newState.channelId && newState.channelId !== oldState.channelId) {
    const ch = newState.channel;
    if (!ch || ch.id === guild.afkChannelId || ch.id === s.suppressAutoJoinChannel || !canJoin(ch)) return;
    try {
      await s.join(ch);
    } catch (e) {
      log.warn(`auto-join failed: ${e.message}`);
    }
  }
});

// "@Fig what's this?" with a screenshot, or any question, in a text channel.
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot || !message.inGuild() || !guildAllowed(message.guild)) return;
    if (!message.mentions.users.has(client.user.id)) return;
    const member = message.member || (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (!member) return;
    const s = getSession(message.guild);
    s.lastTextChannelId = message.channelId;
    const text = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    const img = message.attachments.find((a) => String(a.contentType || '').startsWith('image/'));
    if (!text && !img) return;
    await message.channel.sendTyping().catch(() => {});
    await s.brain.handleText(member, text, {
      reply: (c) => message.reply({ content: String(c).slice(0, 1990), allowedMentions: { repliedUser: false, parse: [] } }),
      image: img ? { url: img.url, contentType: img.contentType } : undefined,
    });
  } catch (e) {
    log.warn('mention handling failed:', e.message);
  }
});

client.on(Events.Error, (e) => {
  log.error('client error:', e.message);
  crash.note(`discord client error: ${e.message}`);
});
client.on(Events.ShardDisconnect, (event, id) => {
  log.warn('gateway disconnected; discord.js will reconnect');
  crash.note(`gateway disconnected shard=${id} code=${event?.code ?? ''} reason=${event?.reason ?? ''}`);
});
client.on(Events.ShardResume, () => {
  log.info('gateway resumed');
  crash.note('gateway resumed');
});
client.on(Events.ShardError, (e) => crash.note(`gateway error: ${e?.message || e}`));
client.on(Events.Invalidated, () => crash.note('discord session invalidated'));

// Stay up. Log unexpected errors instead of dying mid-song.
// An opus crash used to throw this thousands of times a second and fill the disk until Fig died.
let opusCrashes = 0;
let opusWindow = 0;
process.on('unhandledRejection', (e) => {
  log.error('unhandled rejection:', e?.stack || e);
  crash.note(`unhandled rejection: ${e?.stack || e}`);
});
process.on('uncaughtException', (e) => {
  const msg = String(e?.message || e);
  if (/memory access out of bounds/i.test(msg)) {
    const now = Date.now();
    if (now - opusWindow > 60000) {
      opusCrashes = 0;
      opusWindow = now;
    }
    opusCrashes++;
    if (opusCrashes === 1) {
      log.error('opus crashed (memory access). Not logging every repeat.');
      crash.note(`opus memory access crash: ${e?.stack || msg}`);
    }
    if (opusCrashes === 40) {
      log.error('opus kept crashing; exiting so the supervisor can restart clean');
      crash.note('opus kept crashing; exiting for a clean restart');
      process.exit(1);
    }
    return;
  }
  log.error('uncaught exception:', e?.stack || e);
  crash.note(`uncaught exception: ${e?.stack || e}`);
});

let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${sig}: shutting down`);
  crash.note(`shutdown ${sig}`);
  for (const s of sessions.values()) {
    try {
      s.destroy();
    } catch {
      /* ignore */
    }
  }
  store.flushAll();
  await client.destroy().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const loginTimer = setTimeout(() => {
  crash.note('Discord login did not finish within 30s. Exiting so the supervisor can try again.');
  process.exit(1);
}, 30000);
loginTimer.unref?.();

client.login(config.discordToken).catch((e) => {
  log.error(`Discord login failed: ${e.message}`);
  crash.note(`Discord login failed: ${e.message}`);
  process.exit(1);
});
