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
const { InstanceGuard } = require('./discord/instanceGuard');
const instance = require('./util/instance');
const { copyWatch } = require('./util/copyWatch');

// ---- one Fig per token on this machine ----
// Two clients on one bot token fight over the voice channel (old songs cut into the current one).
// The lock is per TOKEN in the system temp folder, so a second checkout in another folder can't start
// a second copy either. (Copies on OTHER machines are caught later by the voice-session check.)
const STANDBY_EXIT = 64; // supervise.js: do not restart
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const alive = (pid) => {
    if (!pid || pid === process.pid) return false;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code !== 'EPERM') return false;
    }
    try {
      if (fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop().trim().startsWith('Z')) return false;
    } catch {
      /* not linux */
    }
    return true;
  };
  const tokenTag = crypto.createHash('sha256').update(String(config.discordToken || 'none')).digest('hex').slice(0, 12);
  const locks = [path.join(os.tmpdir(), `fig-${tokenTag}.pid`), path.join(__dirname, '..', 'logs', 'fig.pid')];
  for (const lock of locks) {
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(lock, 'utf8'));
    } catch {
      try {
        holder = { pid: Number(String(fs.readFileSync(lock, 'utf8')).trim()) };
      } catch {
        holder = null;
      }
    }
    if (holder && alive(holder.pid) && !process.env.FIG_ALLOW_SECOND) {
      const msg = `Another copy of Fig is already running with this bot token (pid ${holder.pid}${holder.dir ? ` in ${holder.dir}` : ''}). Not starting a second one.`;
      console.error(msg);
      try {
        fs.mkdirSync(path.join(__dirname, '..', 'logs'), { recursive: true });
        fs.appendFileSync(path.join(__dirname, '..', 'logs', 'crash.log'), `${new Date().toISOString()} pid=${process.pid} ${msg}\n`);
        require('./log').logger('instance').error(msg);
      } catch {
        /* ignore */
      }
      process.exit(STANDBY_EXIT);
    }
  }
  const me = JSON.stringify({ pid: process.pid, dir: path.join(__dirname, '..'), at: Date.now() });
  for (const lock of locks) {
    try {
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.writeFileSync(lock, me);
    } catch {
      /* ignore */
    }
  }
  process.on('exit', () => {
    for (const lock of locks) {
      try {
        if (JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid) fs.unlinkSync(lock);
      } catch {
        /* ignore */
      }
    }
  });
}

crash.noteIfPreviousDied();
crash.note(`process started: ${instance.describe()}`);
// Heartbeat: a file for scripts/ensure-running.sh, and an IPC message for scripts/supervise.js.
// If the event loop gets stuck these stop, and the supervisor kills and restarts Fig.
function heartbeat() {
  crash.beat();
  if (process.send) {
    try {
      process.send({ type: 'beat', at: Date.now() });
    } catch {
      /* supervisor gone */
    }
  }
}
heartbeat();
setInterval(heartbeat, 10000).unref();
// Without a supervisor, notice a machine freeze ourselves and exit so whatever started us restarts us clean.
if (!process.send) {
  let lastTick = Date.now();
  setInterval(() => {
    const gap = Date.now() - lastTick;
    lastTick = Date.now();
    if (gap > 60000) {
      crash.note(`process was frozen for ~${Math.round(gap / 1000)}s; exiting for a clean restart`);
      process.exit(75);
    }
  }, 5000).unref();
}

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

function homeChannel(guild) {
  const h = String(config.homeVoiceChannel || '').trim().replace(/^#/, '').toLowerCase();
  if (!h) return null;
  return (
    guild.channels.cache.find(
      (c) => (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice) && (c.id === h || String(c.name).toLowerCase() === h),
    ) || null
  );
}

// ---- one Fig per token, across machines ----
// The pid lock only stops a second copy on the same machine/folder. A copy running somewhere else on
// the same token shows up as our bot user's voice state with a gateway session that isn't ours.
const guard = new InstanceGuard();
client.on(Events.Raw, (p) => {
  guard.onRaw(p);
  if (p && p.t === 'READY') log.info(`gateway READY: session ${p.d?.session_id} (${instance.describe()})`);
  if (p && p.t === 'RESUMED') log.info(`gateway RESUMED: session ${guard.current}`);
});

function enterStandby(guild, vs, { announceAfterMs = 0 } = {}) {
  const s = getSession(guild);
  const firstTime = !s.standby;
  s.standBy();
  if (!firstTime) return;
  const ch = guild.channels.cache.get(vs.channelId);
  const msg =
    `Another copy of Fig is running on this bot token and is using #${ch?.name || 'voice'}. ` +
    `Two copies fight over the voice channel, which is what makes old songs cut into the current one. ` +
    `This copy (${instance.describe()}) is stepping aside and staying quiet. Only one copy of Fig should run.`;
  copyWatch.report('voice', `our bot user is in #${ch?.name || vs.channelId} under gateway session ${vs.sessionId}; ours is ${guard.current}`);
  log.error(msg);
  const say = () => {
    if (!s.standby) return; // it was a leftover voice state from our own previous run, and it went away
    s.voiceChannelId = vs.channelId;
    s.postText(msg);
  };
  if (announceAfterMs) setTimeout(say, announceAfterMs).unref?.();
  else say();
}

// While standing by, look every minute: once our bot user's voice state is gone or ours, be active again.
setInterval(() => {
  for (const s of sessions.values()) {
    if (!s.standby) continue;
    const mine = s.guild.voiceStates.cache.get(client.user?.id);
    if (!guard.isForeign(mine)) {
      s.leaveStandby();
      crash.note('no other Fig copy in voice any more; this copy is active again');
      autoJoinBusiest(s.guild).catch(() => {});
    }
  }
}, 60000).unref();

/** Join where people are; with HOME_VOICE_CHANNEL set, go home when nobody is anywhere. */
async function autoJoinBusiest(guild) {
  if (!config.autoJoin) return;
  const s = getSession(guild);
  if (s.connection || s.standby) return;
  const mine = guild.voiceStates.cache.get(client.user.id);
  if (guard.isForeign(mine)) {
    // Right after a restart this can be the voice state our previous run left behind (Discord clears it
    // within a minute or so). Stay out of the channel either way; only announce if it doesn't go away.
    log.warn(`our bot user is already in voice under another session (${mine.sessionId}); waiting instead of joining`);
    enterStandby(guild, mine, { announceAfterMs: 120000 });
    return;
  }
  const channels = guild.channels.cache
    .filter((c) => (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice) && c.id !== guild.afkChannelId)
    .filter((c) => humans(c).length > 0 && canJoin(c) && c.id !== s.suppressAutoJoinChannel)
    .sort((a, b) => humans(b).length - humans(a).length);
  const home = homeChannel(guild);
  // People in the home channel win ties; otherwise go where the people are; otherwise go home.
  let target = channels.first();
  if (home && humans(home).length && humans(home).length >= humans(target || home).length) target = home;
  if (!target && home && config.stayInHome && canJoin(home) && home.id !== s.suppressAutoJoinChannel) target = home;
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
      s.wantConnected = true;
      s.voiceChannelId = target.id;
      s.scheduleRejoin(); // keep trying; never stay out because of one failed join
    }
  } else {
    log.info(`auto-join ${guild.name}: nobody to join. channels: ${summary || 'none cached'}`);
  }
}

client.once(Events.ClientReady, async (c) => {
  clearTimeout(loginTimer);
  log.info(`ready in ${c.guilds.cache.size} server(s): ${c.guilds.cache.map((g) => g.name).join(', ')}`);
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
  if (i.guild && sessions.get(i.guild.id)?.standby) return; // the active copy answers
  onInteraction(i, getSession);
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild;
  if (!guildAllowed(guild)) return;
  {
    // Log every voice change in the server, including Fig's own (with which gateway session owns it).
    const who = newState.member?.displayName || newState.id;
    const from = oldState.channel?.name || oldState.channelId || '-';
    const to = newState.channel?.name || newState.channelId || '-';
    const flags = ['serverMute', 'serverDeaf', 'selfMute', 'selfDeaf', 'streaming', 'selfVideo']
      .filter((f) => oldState[f] !== newState[f])
      .map((f) => `${f}=${newState[f]}`);
    const mine = newState.id === client.user.id;
    const sess = mine ? ` session=${newState.sessionId || '-'} ${guard.isForeign(newState) ? 'FOREIGN (another copy of Fig)' : 'ours'}` : '';
    log.info(`voice state ${mine ? 'FIG' : who}: #${from} -> #${to}${flags.length ? ` ${flags.join(' ')}` : ''}${sess}`);
  }
  const s = getSession(guild);

  // Fig's own voice state.
  if (newState.id === client.user.id) {
    if (guard.isForeign(newState)) {
      // Another copy just took (or holds) the voice channel. Do not fight it.
      enterStandby(guild, newState);
      return;
    }
    if (s.standby) {
      if (!newState.channelId) {
        // The other copy left voice (or its leftover state expired). Become the active copy again.
        s.leaveStandby();
        crash.note('other Fig copy left voice; this copy is active again');
        setTimeout(() => autoJoinBusiest(guild).catch(() => {}), 2000).unref?.();
      }
      return;
    }
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

  if (s.standby) return;
  if (s.connection || s.wantConnected) {
    // Fig is sitting alone (e.g. in its home channel) and people gathered somewhere else: go to them.
    const mine = s.voiceChannel();
    const joined = newState.channel;
    if (
      config.autoJoin &&
      s.connection &&
      joined &&
      joined.id !== s.voiceChannelId &&
      joined.id !== guild.afkChannelId &&
      mine &&
      humans(mine).length === 0 &&
      canJoin(joined)
    ) {
      log.info(`moving to #${joined.name}: people are there and #${mine.name} is empty`);
      s.join(joined).catch((e) => log.warn(`move failed: ${e.message}`));
      return;
    }
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
  // A message from our own bot user that this copy didn't send = another copy is running (any machine).
  if (message.author?.id === client.user?.id && message.inGuild?.()) {
    copyWatch
      .checkOwnMessage(message)
      .then((foreign) => {
        if (foreign && !sessions.get(message.guild.id)?.standby) copyWatch.warnInChat(getSession(message.guild), copyWatch.recent[copyWatch.recent.length - 1]);
      })
      .catch(() => {});
    return;
  }
  try {
    if (message.author.bot || !message.inGuild() || !guildAllowed(message.guild)) return;
    if (!message.mentions.users.has(client.user.id)) return;
    if (sessions.get(message.guild.id)?.standby) return; // the active copy answers
    const member = message.member || (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (!member) return;
    const s = getSession(message.guild);
    s.lastTextChannelId = message.channelId;
    const text = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    const img = message.attachments.find((a) => String(a.contentType || '').startsWith('image/'));
    if (!text && !img) return;
    await message.channel.sendTyping().catch(() => {});
    await s.brain.handleText(member, text, {
      reply: (c) => copyWatch.track(message.reply({ content: String(c).slice(0, 1990), allowedMentions: { repliedUser: false, parse: [] } })),
      image: img ? { url: img.url, contentType: img.contentType } : undefined,
    });
  } catch (e) {
    log.warn('mention handling failed:', e.message);
  }
});

// If the gateway stays down (e.g. after the machine was paused), restart instead of sitting deaf.
let notReadySince = 0;
setInterval(() => {
  if (!client.readyAt) return; // still logging in; the login timer handles that
  if (client.ws.status === 0) {
    notReadySince = 0;
    return;
  }
  notReadySince = notReadySince || Date.now();
  if (Date.now() - notReadySince > 3 * 60 * 1000) {
    crash.note(`gateway not ready for 3 minutes (status ${client.ws.status}); exiting so the supervisor restarts clean`);
    process.exit(1);
  }
}, 15000).unref();

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
      crash.note(`opus memory access crash (not logging every repeat): ${e?.stack || msg}`);
    }
    if (opusCrashes === 40) {
      crash.note('opus kept crashing; exiting for a clean restart');
      process.exit(1);
    }
    return;
  }
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

// ---- live status + log page (src/web) ----
function statusSnapshot() {
  return {
    copy: { host: require('node:os').hostname(), pid: process.pid, sha: instance.sha, uptime: instance.uptime(), describe: instance.describe() },
    gateway: { ready: Boolean(client.readyAt) && client.ws.status === 0, user: client.user?.tag || null, session: guard.current, ping: client.ws.ping },
    copies: copyWatch.snapshot(),
    servers: [...sessions.values()].map((s) => {
      try {
        return s.statusSnapshot();
      } catch (e) {
        return { server: s.guild?.name, voice: `status failed: ${e.message}` };
      }
    }),
  };
}
require('./web/server').startWebServer({ getStatus: statusSnapshot });

client.login(config.discordToken).catch((e) => {
  log.error(`Discord login failed: ${e.message}`);
  crash.note(`Discord login failed: ${e.message}`);
  process.exit(1);
});
