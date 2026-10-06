'use strict';
// Every thing Fig can do, in one place. Voice commands (via Grok tools) and slash commands both
// call these, so behaviour is identical no matter how you ask.
//
// Each action returns { ok, say, text?, quiet? }
//   say   - short line for Fig to speak / post (null = nothing to say, e.g. the music itself confirms it)
//   text  - longer text for chat (defaults to say)
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { allowed, denyMessage } = require('./discord/permissions');
const { moderate: runModeration, resolveMember, ACTIONS: MOD_ACTIONS } = require('./discord/moderation');
const personalities = require('./brain/personalities');
const grok = require('./brain/grok');
const { decodeImage } = require('./util/images');
const { fmtEntry } = require('./music/player');
const store = require('./store');
const { config, MODES } = require('./config');
const log = require('./log').logger('actions');

const ok = (say, extra = {}) => ({ ok: true, say, ...extra });
const no = (say, extra = {}) => ({ ok: false, say, ...extra });

function need(ctx, cap) {
  if (allowed(ctx.member, cap)) return null;
  return no(denyMessage(cap));
}

function nameOf(member) {
  return member?.displayName || member?.user?.username || 'someone';
}

// ------------------------------------------------------------------ voice channel

async function join(ctx, channel) {
  const ch = channel || ctx.member?.voice?.channel;
  if (!ch) return no('Join a voice channel first and I will come to you.');
  if (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) return no("That isn't a voice channel.");
  const perms = ch.permissionsFor(ctx.session.guild.members.me);
  if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) return no(`I need Connect and Speak permissions in ${ch.name}.`);
  try {
    await ctx.session.join(ch);
    return ok(null, { text: `Joined **${ch.name}**.` });
  } catch (e) {
    return no(`I couldn't join ${ch.name}: ${e.message}`);
  }
}

async function leave(ctx) {
  if (!ctx.session.connection) return no("I'm not in a voice channel.");
  await ctx.session.leave({ byRequest: true });
  return ok(null, { text: 'Left the voice channel. Use /join to bring me back.' });
}

async function ensureVoice(ctx) {
  if (ctx.session.connection) return null;
  const ch = ctx.member?.voice?.channel;
  if (!ch) return no('Hop in a voice channel first, then ask again.');
  const r = await join(ctx, ch);
  return r.ok ? null : r;
}

// ------------------------------------------------------------------ music

async function play(ctx, { query, when = 'queue' }) {
  const denied = need(ctx, 'ask');
  if (denied) return denied;
  if (!query || !String(query).trim()) return no('What should I play?');
  if ((when === 'now' || when === 'next') && !allowed(ctx.member, 'control')) when = 'queue';
  const vErr = await ensureVoice(ctx);
  if (vErr) return vErr;
  const player = ctx.session.player;
  const res = await player.request(String(query).trim(), {
    requestedBy: { id: ctx.member?.id, name: nameOf(ctx.member) },
    playNext: when === 'next',
    playNow: when === 'now',
  });
  if (!res.ok) return no(res.error);
  const first = res.entries[0];
  const many = res.entries.length > 1 ? ` (+${res.entries.length - 1} more from the playlist)` : '';
  if (res.startsNow || when === 'now') {
    // The music starting is the confirmation. "Now playing" is posted when audio actually starts.
    return ok(null, { text: `Loading **${first.title}**${many}...`, startsNow: true, entry: first });
  }
  const pos = when === 'next' ? 'next up' : `#${res.position} in the queue`;
  return ok(`Queued ${first.title}, ${pos}.`, { text: `Queued **${first.title}**${many}, ${pos}.`, entry: first });
}

function skip(ctx) {
  const denied = need(ctx, 'control');
  if (denied) return denied;
  const skipped = ctx.session.player.skip();
  if (!skipped) return no("Nothing's playing.");
  return ok(null, { text: `Skipped **${skipped.title}**.` });
}

function remove(ctx, { which }) {
  const denied = need(ctx, 'control');
  if (denied) return denied;
  const gone = ctx.session.player.remove(which);
  if (!gone) return no(`I couldn't find "${which}" in the queue.`);
  return ok(`Dropped ${gone.title} from the queue.`, { text: `Removed **${gone.title}** from the queue.` });
}

function pause(ctx) {
  const denied = need(ctx, 'control');
  if (denied) return denied;
  if (!ctx.session.player.current) return no("Nothing's playing.");
  if (!ctx.session.player.pause()) return ok(null, { text: 'Already paused.' });
  return ok(null, { text: 'Paused. It stays paused until someone says resume.' });
}

function resume(ctx) {
  const denied = need(ctx, 'control');
  if (denied) return denied;
  if (!ctx.session.player.resume()) {
    if (!ctx.session.player.current) return no("There's nothing to resume.");
    return ok(null, { text: "It's already playing." });
  }
  return ok(null, { text: 'Resumed.' });
}

function stop(ctx) {
  const denied = need(ctx, 'control');
  if (denied) return denied;
  const had = ctx.session.player.stop();
  return had ? ok('Stopped the music and cleared the queue.', { text: 'Stopped the music, cleared the queue, DJ off.' }) : no("Nothing's playing.");
}

function clear(ctx) {
  const denied = need(ctx, 'control');
  if (denied) return denied;
  const n = ctx.session.player.clearQueue();
  if (ctx.session.dj.enabled) ctx.session.dj.turnOff({ silent: true });
  return ok(n ? `Cleared ${n} song${n === 1 ? '' : 's'} from the queue.` : 'The queue was already empty.');
}

function shuffle(ctx) {
  const denied = need(ctx, 'control');
  if (denied) return denied;
  const n = ctx.session.player.shuffle();
  return n > 1 ? ok('Shuffled the queue.') : no('Not enough songs in the queue to shuffle.');
}

function queue(ctx) {
  return ok(null, { text: '```\n' + ctx.session.player.describe(15) + '\n```', speakSummary: summarize(ctx.session) });
}

function summarize(session) {
  const np = session.player.nowPlaying();
  const n = session.player.queue.length;
  if (!np) return n ? `Nothing playing, ${n} queued.` : 'Nothing playing and the queue is empty.';
  return `${np.paused ? 'Paused on' : 'Playing'} ${np.entry.title}, ${n} more in the queue.`;
}

function nowPlaying(ctx) {
  const np = ctx.session.player.nowPlaying();
  if (!np) return ok("Nothing's playing right now.");
  const st = np.status === 'loading' ? 'Loading' : np.paused ? 'Paused' : 'Now playing';
  return ok(`${st}: ${np.entry.title}.`, { text: `${st}: ${fmtEntry(np.entry)}\n${np.entry.url}` });
}

function volume(ctx, { level, change }) {
  const player = ctx.session.player;
  if (level === undefined && !change) return ok(`Volume is ${player.volume} percent.`);
  const denied = need(ctx, 'control');
  if (denied) return denied;
  let v = player.volume;
  if (typeof level === 'number' && Number.isFinite(level)) v = level;
  else if (change === 'up') v = v + 10;
  else if (change === 'down') v = v - 10;
  const set = player.setVolume(v);
  return ok(null, { text: `Volume ${set}%.` });
}

function dj(ctx, { action = 'on', mood }) {
  const denied = need(ctx, 'dj');
  if (denied) return denied;
  const d = ctx.session.dj;
  if (action === 'off') {
    const was = d.turnOff();
    return was ? ok("DJ's off. I'll finish this song.", { text: 'DJ off. The current song keeps playing.' }) : no("DJ wasn't on.");
  }
  return (async () => {
    const vErr = await ensureVoice(ctx);
    if (vErr) return vErr;
    const m = d.turnOn(mood);
    return ok(`DJ's on. Mood: ${m}.`, { text: `DJ on. Mood: **${m}**.` });
  })();
}

// ------------------------------------------------------------------ Fig settings

function setMode(ctx, { mode }) {
  const denied = need(ctx, 'control');
  if (denied) return denied;
  const m = String(mode || '').toLowerCase();
  if (!MODES.includes(m)) return no(`Modes are: ${MODES.join(', ')}.`);
  store.updateSettings(ctx.session.guild.id, { mode: m });
  const blurb = {
    conversation: "No need to say my name. I'm all ears.",
    quiet: "I'll only answer when you say my name.",
    normal: "I'll answer when you say my name or clearly ask for something.",
    active: "I'll chime in when it's relevant.",
    chaos: "I'm just another person in the call now. Good luck.",
  }[m];
  return ok(`${cap(m)} mode. ${blurb}`);
}

async function setPersonality(ctx, { preset, description }) {
  const denied = need(ctx, 'control');
  if (denied) return denied;
  if (description && String(description).trim()) {
    try {
      const custom = await personalities.generate(String(description).trim());
      store.updateSettings(ctx.session.guild.id, { personality: { preset: null, custom } });
      return ok(`New personality: ${custom.label}.`, { text: `New personality: **${custom.label}**\n> ${custom.prompt}` });
    } catch (e) {
      return no(`I couldn't make that personality: ${e.message}`);
    }
  }
  const key = String(preset || '').toLowerCase();
  if (!personalities.PRESETS[key]) return no(`Presets: ${Object.keys(personalities.PRESETS).join(', ')}.`);
  store.updateSettings(ctx.session.guild.id, { personality: { preset: key, custom: null }, voice: personalities.PRESETS[key].voice });
  const voice = personalities.voiceLabel(personalities.PRESETS[key].voice);
  return ok(`Personality set to ${personalities.PRESETS[key].label}. Voice is ${voice}.`);
}

async function setVoice(ctx, { voice }) {
  const denied = need(ctx, 'control');
  if (denied) return denied;
  const v = String(voice || '').toLowerCase().trim();
  const known = new Set([...(await grok.listVoices()), ...personalities.VOICE_IDS]);
  if (!known.has(v)) return no(`I don't have a voice called ${voice}. Try /voice list.`);
  store.updateSettings(ctx.session.guild.id, { voice: v });
  return ok(`This is my new voice. I'm ${personalities.voiceLabel(v)}.`);
}

function setName(ctx, { name }) {
  const denied = need(ctx, 'control');
  if (denied) return denied;
  const n = String(name || '').trim();
  if (!n || n.length > 24 || !/[a-z]/i.test(n)) return no('Give me a name with letters, up to 24 characters.');
  store.updateSettings(ctx.session.guild.id, { wakeName: n });
  return ok(`Call me ${n} from now on.`);
}

// ------------------------------------------------------------------ talking

function sayLine(ctx, { text }) {
  const t = String(text || '').trim();
  if (!t) return no('What should I say?');
  return ok(t.slice(0, 500), { verbatim: true });
}

function shutUp(ctx) {
  ctx.session.mixer.stopVoice();
  ctx.session.cancelSpeech();
  return ok(null, { text: '(stopped talking)' });
}

function forget(ctx) {
  ctx.session.memory.forget();
  ctx.session.pendingConfirm = null;
  return ok('Forgotten.', { text: 'Forgot the recent conversation and dropped anything I was holding.' });
}

function status(ctx) {
  const s = ctx.session;
  const st = store.settings(s.guild.id);
  const p = personalities.resolve(st.personality);
  const ch = s.voiceChannel();
  const np = s.player.nowPlaying();
  const lines = [
    `Voice: ${ch ? `in **${ch.name}**` : 'not in a channel'}${s.connection ? ` (${s.connection.state.status})` : ''}`,
    `Music: ${np ? `${np.paused ? 'paused on' : np.status === 'loading' ? 'loading' : 'playing'} ${np.entry.title}` : 'nothing'}; ${s.player.queue.length} queued; volume ${s.player.volume}%`,
    `DJ: ${s.dj.enabled ? `on (${s.dj.mood})` : 'off'}`,
    `Mode: ${st.mode}; name: ${st.wakeName}; personality: ${p.label}; voice: ${st.voice}`,
    `Listening: ${s.listener ? 'yes' : 'no'}${s.memory.heldImage() ? '; holding an image' : ''}${s.timers.size ? `; ${s.timers.size} timer(s)` : ''}`,
  ];
  const spoken = `${ch ? `I'm in ${ch.name}` : "I'm not in a call"}, ${summarize(s).replace(/^./, (c) => c.toLowerCase())}${s.dj.enabled ? ` DJ is on, mood ${s.dj.mood}.` : ''} ${cap(st.mode)} mode.`;
  return ok(spoken, { text: lines.join('\n') });
}

function timer(ctx, { seconds, label }) {
  const secs = Math.round(Number(seconds));
  if (!Number.isFinite(secs) || secs < 1 || secs > 24 * 3600) return no('Timers can be 1 second to 24 hours.');
  const what = String(label || 'timer').trim().slice(0, 80) || 'timer';
  const who = ctx.member;
  const t = setTimeout(() => {
    ctx.session.timers.delete(t);
    const line = `${nameOf(who)}, your ${what === 'timer' ? '' : `${what} `}timer is done.`;
    ctx.session.respond({ member: who, text: line, mention: true, ping: true });
  }, secs * 1000);
  t.unref?.();
  ctx.session.timers.add(t);
  return ok(`Timer set for ${humanDuration(secs)}.`);
}

// ------------------------------------------------------------------ knowing things

async function webLookup(ctx, { question }) {
  const q = String(question || '').trim();
  if (!q) return no('What should I look up?');
  try {
    const answer = await grok.webAnswer({
      instructions: `${ctx.session.personaPrompt()}\nAnswer the question using web search. Reply in at most 2 short spoken sentences, no URLs, no markdown.`,
      input: q,
    });
    return ok(answer || "I couldn't find a good answer.", { answer: true });
  } catch (e) {
    log.warn('web lookup failed:', e.message);
    return no("I couldn't look that up right now.");
  }
}

async function factCheck(ctx) {
  const lines = ctx.session.memory
    .recentTranscript(20)
    .filter((l) => !l.fig)
    .map((l) => `${l.name}: ${l.text}`);
  if (!lines.length) return no("I didn't catch anything to fact-check yet.");
  try {
    const answer = await grok.webAnswer({
      instructions:
        `${ctx.session.personaPrompt()}\n` +
        `You fact-check claims made in a voice call. ${nameOf(ctx.member)} asked you to fact-check. ` +
        'Find the most recent factual claim made BEFORE the fact-check request (prefer the requester\'s own latest claim). ' +
        'Verify it with web search. Reply in at most 2 spoken sentences: restate the claim in a few words, give the verdict ' +
        '(true, false, partly true, or unclear) and the key fact. No URLs, no markdown. If there is no checkable claim, say so.',
      input: `Transcript, oldest first:\n${lines.join('\n')}`,
      maxTokens: 400,
    });
    return ok(answer || "I couldn't check that.", { answer: true });
  } catch (e) {
    log.warn('fact check failed:', e.message);
    return no("I couldn't fact-check that right now.");
  }
}

/** Look at an image. `image` may be { url } (Discord attachment) or omitted to use the held image. */
async function look(ctx, { question, image } = {}) {
  const mem = ctx.session.memory;
  let dataUrl = null;
  if (image?.url) {
    try {
      dataUrl = await decodeImage(image.url, image.contentType);
    } catch (e) {
      return no(`I couldn't open that image: ${e.message}`);
    }
    mem.holdImage(dataUrl, nameOf(ctx.member));
  } else {
    dataUrl = mem.heldImage()?.dataUrl;
  }
  if (!dataUrl) return no("I'm not holding any image. Send one with /look or mention me with a screenshot.");
  try {
    const answer = await grok.vision({
      system: `${ctx.session.personaPrompt()}\nSomeone in the call is showing you an image. Say what you see and answer their question in 1-3 short spoken sentences. No markdown.`,
      question: String(question || 'What do you see?'),
      imageUrl: dataUrl,
    });
    return ok(answer || "I can't make it out.", { answer: true });
  } catch (e) {
    log.warn('vision failed:', e.message);
    return no("I couldn't look at that right now.");
  }
}

function dropImage(ctx) {
  return ctx.session.memory.dropImage() ? ok('Dropped it.') : ok("I wasn't holding anything.");
}

// ------------------------------------------------------------------ moderation

async function moderate(ctx, { action, person, minutes, reason, confirmed = false }) {
  const act = String(action || '').toLowerCase();
  if (!MOD_ACTIONS[act]) return no(`I can: ${Object.keys(MOD_ACTIONS).join(', ')}.`);
  let target = person && typeof person === 'object' && person.id ? person : null;
  if (!target) {
    const r = await resolveMember(ctx.session.guild, String(person || ''), ctx.session.voiceChannel());
    if (r.ambiguous) return no(`Which one: ${r.ambiguous.join(', ')}?`);
    if (!r.member) return no(`I couldn't find anyone called ${person}.`);
    target = r.member;
  }
  if (!ctx.member?.permissions?.has(MOD_ACTIONS[act].perm)) return no(`You don't have permission to ${MOD_ACTIONS[act].label} people.`);
  // Bans by voice need a spoken "yes" first. Speech-to-text can mishear names.
  if (act === 'ban' && ctx.source === 'voice' && !confirmed) {
    ctx.session.pendingConfirm = { userId: ctx.member.id, until: Date.now() + 20000, run: () => moderate(ctx, { action, person: target, minutes, reason, confirmed: true }) };
    return ok(`Ban ${target.displayName}? Say yes to confirm.`);
  }
  const r = await runModeration({ guild: ctx.session.guild, actor: ctx.member, target, action: act, minutes, reason });
  return r.ok ? ok(r.message) : no(r.message);
}

// ------------------------------------------------------------------ helpers

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function humanDuration(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return [h && `${h} hour${h > 1 ? 's' : ''}`, m && `${m} minute${m > 1 ? 's' : ''}`, s && `${s} second${s > 1 ? 's' : ''}`].filter(Boolean).join(' ');
}

/** "5m", "90s", "1h30m", "10" (minutes) -> seconds */
function parseDuration(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 60);
  let total = 0;
  let matched = false;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)/g)) {
    matched = true;
    const n = Number(m[1]);
    const u = m[2][0];
    total += u === 'h' ? n * 3600 : u === 'm' ? n * 60 : n;
  }
  return matched ? Math.round(total) : NaN;
}

module.exports = {
  join,
  leave,
  play,
  skip,
  remove,
  pause,
  resume,
  stop,
  clear,
  shuffle,
  queue,
  nowPlaying,
  volume,
  dj,
  setMode,
  setPersonality,
  setVoice,
  setName,
  sayLine,
  shutUp,
  forget,
  status,
  timer,
  webLookup,
  factCheck,
  look,
  dropImage,
  moderate,
  parseDuration,
  humanDuration,
  summarize,
};
