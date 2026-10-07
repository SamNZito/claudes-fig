'use strict';
// One GuildSession per server. Owns the voice connection, the audio player, the mixer, the music,
// the DJ, the listener and the brain, and keeps them alive across call blips.
const { EventEmitter } = require('node:events');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} = require('@discordjs/voice');
const { Mixer } = require('../audio/mixer');
const { MusicPlayer } = require('../music/player');
const { DJ } = require('../music/dj');
const { Listener } = require('./listener');
const { Memory } = require('../brain/memory');
const { Brain } = require('../brain/brain');
const personalities = require('../brain/personalities');
const { synthesize, forText } = require('../audio/tts');
const { allowed } = require('../discord/permissions');
const store = require('../store');
const { config } = require('../config');
const log = require('../log').logger('session');
const crash = require('../crashlog');
const sources = require('../music/sources');

const REJOIN_DELAYS = [2000, 5000, 10000, 20000, 30000, 60000];

/** People in a voice channel. Uses voice states, not the member list (that intent is off). */
function humanMembers(channel) {
  if (!channel) return [];
  const states = channel.guild?.voiceStates?.cache;
  if (states && typeof states.values === 'function' && states.size) {
    const out = [];
    for (const vs of states.values()) {
      if (vs.channelId !== channel.id) continue;
      if (vs.member?.user?.bot) continue;
      out.push(vs.member || { id: vs.id, displayName: 'someone', user: { bot: false, id: vs.id } });
    }
    return out;
  }
  if (channel.members && typeof channel.members.values === 'function') {
    return [...channel.members.values()].filter((m) => m && !m.user?.bot);
  }
  return [];
}

class GuildSession extends EventEmitter {
  constructor(client, guild) {
    super();
    this.client = client;
    this.guild = guild;
    const st = store.settings(guild.id);
    this.mixer = new Mixer({ volume: st.volume, duckLevel: config.duckLevel, duckMode: config.duckMode, voiceVolume: config.voiceVolume });
    this.player = new MusicPlayer({ guildId: guild.id, mixer: this.mixer });
    this.dj = new DJ({ guildId: guild.id, player: this.player });
    this.memory = new Memory();
    this.brain = new Brain(this);
    this.timers = new Set();
    this.pendingConfirm = null;
    this.focus = null;

    this.connection = null;
    this.listener = null;
    this.voiceChannelId = null;
    this.lastTextChannelId = null;
    this.wantConnected = false;
    this.leaving = false;
    this.selfDisconnectAt = 0;
    this.rejoinAttempt = 0;
    this.rejoinTimer = null;
    this.emptyTimer = null;
    this.suppressAutoJoinChannel = null; // after "leave", don't auto-join this channel until it empties

    this.speechChain = Promise.resolve();
    this.speechEpoch = 0;

    this.audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 250 } });
    this.audioPlayer.on('error', (e) => log.warn(`audio player error: ${e.message}`));
    this.audioPlayer.on('stateChange', (oldS, newS) => {
      if (newS.status === AudioPlayerStatus.Idle && oldS.status !== AudioPlayerStatus.Idle && !this.mixer.idle) {
        // The resource died unexpectedly. Give the player a fresh one; the mixer state is untouched.
        setImmediate(() => this.transportOn());
      }
    });
    this.mixer.on('active', () => this.transportOn());
    this.mixer.on('idle', () => this.transportOff());
    this.mixer.on('warn', (m) => log.warn(m));

    this.player.on('nowPlaying', (e) => this.onNowPlaying(e));
    this.player.on('trackFailed', (e, reason) => this.onTrackFailed(e, reason));
    this.player.on('trackCut', (e, reason) => this.postText(`**${e.asked || e.title}** got cut off (${reason}). Moving on.`));
    this.onSourceDownBound = (src, reason) => this.onSourceDown(src, reason);
    sources.events.on('down', this.onSourceDownBound);
    this.dj.on('stuck', (mood) => {
      this.postText(`DJ couldn't find anything new that fits **${mood}**. Try another mood with /dj.`);
      this.speak(`I'm out of fresh ideas for ${mood}. Give me another mood?`);
    });
  }

  // ------------------------------------------------------------------ transport

  transportOn() {
    if (this.destroyed) return;
    const st = this.audioPlayer.state.status;
    if (st === AudioPlayerStatus.Idle) {
      const resource = createAudioResource(this.mixer.createStream(), { inputType: StreamType.Opus, silencePaddingFrames: 0 });
      this.audioPlayer.play(resource);
    } else if (st === AudioPlayerStatus.Paused) {
      this.audioPlayer.unpause();
    }
  }

  transportOff() {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Playing) this.audioPlayer.pause(true);
  }

  // ------------------------------------------------------------------ voice connection

  voiceChannel() {
    return this.voiceChannelId ? this.guild.channels.cache.get(this.voiceChannelId) || null : null;
  }

  humansIn(channel) {
    return humanMembers(channel);
  }

  peopleInCall() {
    return this.humansIn(this.voiceChannel()).map((m) => m.displayName);
  }

  isReady() {
    return this.connection?.state?.status === VoiceConnectionStatus.Ready;
  }

  async join(channel, { rejoin = false } = {}) {
    // Every new call starts in normal mode (wake name required). A reconnect after a blip keeps the mode.
    if (!rejoin && !this.connection) this.startNewCall();
    this.wantConnected = true;
    this.suppressAutoJoinChannel = null;
    clearTimeout(this.rejoinTimer);
    if (this.connection && this.voiceChannelId === channel.id && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      if (this.isReady()) return;
    }
    this.voiceChannelId = channel.id;
    const conn = joinVoiceChannel({
      channelId: channel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      daveEncryption: true,
    });
    this.bindConnection(conn);
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 20000);
      this.rejoinAttempt = 0;
      log.info(`connected to #${channel.name} in ${this.guild.name}`);
      crash.note(`connected to #${channel.name} in ${this.guild.name}`);
      this.restoreDj();
    } catch (e) {
      log.warn(`could not connect to ${channel.name}: ${e.message}`);
      crash.note(`could not connect to #${channel.name}: ${e.message}`);
      this.selfDisconnectAt = Date.now();
      if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
      throw new Error('voice connection timed out');
    }
  }

  /** A fresh call (not a reconnect): start in normal mode, wake name required. */
  startNewCall() {
    if (config.resetModeOnJoin && store.settings(this.guild.id).mode !== 'normal') {
      store.updateSettings(this.guild.id, { mode: 'normal' });
      log.info('new call: mode reset to normal');
    }
  }

  bindConnection(conn) {
    if (this.connection === conn) return;
    this.connection = conn;
    conn.subscribe(this.audioPlayer);
    conn.on('error', (e) => {
      log.warn(`voice connection error: ${e.message}`);
      crash.note(`voice connection error: ${e.message}`);
    });
    conn.on('stateChange', async (oldS, newS) => {
      if (this.connection !== conn) return;
      if (newS.status === VoiceConnectionStatus.Ready) {
        this.rejoinAttempt = 0;
        this.startListening(conn);
      } else if (newS.status === VoiceConnectionStatus.Disconnected) {
        // Either a quick blip (Discord moves us to a new voice server) or a real drop.
        try {
          await Promise.race([
            entersState(conn, VoiceConnectionStatus.Signalling, 5000),
            entersState(conn, VoiceConnectionStatus.Connecting, 5000),
          ]);
          log.info('voice blip; reconnecting');
          crash.note('voice blip; reconnecting');
        } catch {
          if (this.connection !== conn) return;
          log.warn('voice connection dropped');
          crash.note(`voice connection dropped (close code ${newS.closeCode ?? ''})`);
          this.stopListening();
          this.cancelSpeech(); // don't blurt out stale sentences after reconnecting
          this.selfDisconnectAt = Date.now();
          if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
          if (this.connection === conn) this.connection = null;
          if (this.wantConnected && !this.leaving) this.scheduleRejoin();
        }
      } else if (newS.status === VoiceConnectionStatus.Destroyed) {
        if (this.connection === conn) {
          this.stopListening();
          this.connection = null;
        }
      }
    });
  }

  scheduleRejoin() {
    clearTimeout(this.rejoinTimer);
    // Fast retries first, then every 5 minutes forever: a network outage must not leave Fig out for good.
    const delay = this.rejoinAttempt < REJOIN_DELAYS.length ? REJOIN_DELAYS[this.rejoinAttempt] : 5 * 60 * 1000;
    this.rejoinAttempt++;
    if (this.rejoinAttempt === REJOIN_DELAYS.length + 1) {
      crash.note('voice rejoin still failing; retrying every 5 minutes');
      this.postText("I lost the voice connection. I'll keep trying to get back in (or use /join).");
    }
    log.info(`rejoining voice in ${delay / 1000}s (attempt ${this.rejoinAttempt})`);
    this.rejoinTimer = setTimeout(async () => {
      if (!this.wantConnected) return;
      const ch = this.voiceChannel() || this.homeChannel();
      if (!ch) {
        log.info('voice channel is gone; not rejoining');
        this.wantConnected = false;
        return;
      }
      if (!this.humansIn(ch).length && !(this.isHome(ch) && config.stayInHome)) {
        log.info('nobody left in the channel; not rejoining');
        this.wantConnected = false;
        return;
      }
      try {
        await this.join(ch, { rejoin: true });
      } catch {
        this.scheduleRejoin();
      }
    }, delay);
    this.rejoinTimer.unref?.();
  }

  async leave({ byRequest = false, reason = '' } = {}) {
    this.leaving = true;
    this.wantConnected = false;
    clearTimeout(this.rejoinTimer);
    clearTimeout(this.emptyTimer);
    if (byRequest) this.suppressAutoJoinChannel = this.voiceChannelId;
    this.player.stop();
    this.mixer.stopVoice();
    this.stopListening();
    const conn = this.connection;
    this.connection = null;
    this.selfDisconnectAt = Date.now();
    if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
    if (reason) log.info(`left voice: ${reason}`);
    this.leaving = false;
  }

  /**
   * Fig's voice state went empty and we didn't do it. One clear is usually a blip (or the old bot
   * on the same token), so rejoin. Three within 10 minutes means a person keeps disconnecting Fig:
   * stay out until /join. Strikes are NOT reset by a successful rejoin; they age out instead
   * (resetting on rejoin meant the count could never reach three).
   */
  onForcedDisconnect() {
    if (this.leaving || !this.wantConnected) return;
    if (Date.now() - (this.selfDisconnectAt || 0) < 15000) return; // that was us
    const now = Date.now();
    this.kickTimes = (this.kickTimes || []).filter((t) => now - t < 10 * 60 * 1000);
    this.kickTimes.push(now);
    const strikes = this.kickTimes.length;
    crash.note(`left the voice channel unexpectedly (strike ${strikes} in 10 min)`);
    if (strikes >= 3) {
      log.info('disconnected 3 times in 10 minutes; staying out');
      crash.note('disconnected 3 times in 10 minutes; staying out until /join');
      this.kickTimes = [];
      this.suppressAutoJoinChannel = this.voiceChannelId;
      this.leave({ reason: 'disconnected by someone' });
      this.postText('Someone keeps disconnecting me, so I am staying out. Use /join when you want me back.');
      return;
    }
    log.info(`voice channel cleared (strike ${strikes}/3); rejoining`);
    this.selfDisconnectAt = Date.now();
    this.scheduleRejoin();
  }

  /** Is this Fig's home channel (HOME_VOICE_CHANNEL, id or name)? */
  isHome(channel) {
    const h = String(config.homeVoiceChannel || '').trim().replace(/^#/, '').toLowerCase();
    if (!h || !channel) return false;
    return channel.id === h || String(channel.name || '').toLowerCase() === h;
  }

  homeChannel() {
    const h = String(config.homeVoiceChannel || '').trim();
    if (!h) return null;
    return [...this.guild.channels.cache.values()].find((c) => (c.type === 2 || c.type === 13) && this.isHome(c)) || null;
  }

  /** Discord moved us to another channel. */
  onMoved(channelId) {
    this.voiceChannelId = channelId;
  }

  // ------------------------------------------------------------------ listening

  startListening(conn) {
    if (!config.listen) return;
    if (this.listener && this.listener.connection === conn) return;
    this.stopListening();
    const l = new Listener({
      connection: conn,
      shouldListen: (userId) => {
        const m = this.guild.members.cache.get(userId);
        return Boolean(m && !m.user.bot && allowed(m, 'ask'));
      },
    });
    l.on('utterance', (u) => this.brain.onUtterance(u));
    l.start();
    this.listener = l;
  }

  stopListening() {
    if (this.listener) this.listener.stop();
    this.listener = null;
  }

  // ------------------------------------------------------------------ talking

  settings() {
    return store.settings(this.guild.id);
  }

  personaPrompt() {
    return personalities.resolve(this.settings().personality).prompt;
  }

  ctx(member, source = 'voice') {
    return { session: this, member, source };
  }

  isFocused(userId) {
    return Boolean(this.focus && this.focus.userId === userId && Date.now() < this.focus.until);
  }

  setFocus(userId) {
    this.focus = { userId, until: Date.now() + config.followupSeconds * 1000 };
  }

  /** A command is done. The next thing needs the wake name again. */
  clearFocus() {
    this.focus = null;
  }

  cancelSpeech() {
    this.speechEpoch++;
    this.mixer.stopVoice();
  }

  /** Speak in the call (queued, in order). Resolves when finished or skipped. */
  speak(text) {
    if (!this.connection) return Promise.resolve(false);
    const epoch = this.speechEpoch;
    const voice = this.settings().voice;
    const synth = synthesize(text, { voice }).catch((e) => {
      log.warn('TTS failed:', e.message);
      return null;
    });
    this.speechChain = this.speechChain.then(async () => {
      const clip = await synth;
      if (!clip || epoch !== this.speechEpoch) {
        clip?.destroy();
        return false;
      }
      return this.mixer.addVoice(clip);
    });
    return this.speechChain;
  }

  /**
   * Reply to one person: text in chat (or as the reply to their command) and spoken in the call.
   */
  async respond({ member, text, source = 'voice', reply = null, mention = true, ping = false }) {
    const shown = forText(text);
    const name = this.settings().wakeName;
    if (reply) {
      await reply(shown).catch((e) => log.warn('reply failed:', e.message));
    } else {
      const who = member ? (ping ? `<@${member.id}>` : `**${member.displayName}**`) : '';
      this.postText(mention && who ? `**${name}** → ${who}: ${shown}` : shown, { pingUser: ping ? member?.id : null });
    }
    if (this.connection) {
      await this.speak(text);
      if (member && source === 'voice' && mention) this.setFocus(member.id);
    }
  }

  textChannel() {
    const ids = [config.announceChannelId, this.voiceChannelId, this.lastTextChannelId].filter(Boolean);
    for (const id of ids) {
      const ch = this.guild.channels.cache.get(id);
      if (ch && ch.isTextBased?.() && ch.permissionsFor(this.guild.members.me)?.has('SendMessages')) return ch;
    }
    return null;
  }

  postText(content, { reply = null, pingUser = null } = {}) {
    if (!content) return;
    if (reply) {
      reply(content).catch(() => {});
      return;
    }
    const ch = this.textChannel();
    if (!ch) return;
    ch.send({ content: content.slice(0, 1900), allowedMentions: { users: pingUser ? [pingUser] : [] } }).catch((e) => log.debug('post failed:', e.message));
  }

  /** Short chat note for fast voice commands, so the chat shows what happened. */
  postLog(member, heard, r) {
    const t = r.text || r.say;
    if (!t) return;
    this.postText(`*${member.displayName}: "${heard}"* → ${t}`);
  }

  onNowPlaying(entry) {
    if (entry.via === 'dj') this.dj.onPickResult(true);
    const who = entry.via === 'dj' ? `DJ (${this.dj.mood})` : `requested by ${entry.requestedBy?.name || 'someone'}`;
    this.postText(`Now playing: **${entry.title}**${entry.channel ? ` - ${entry.channel}` : ''} (${who})`);
    if (config.djTalk && entry.via === 'dj') this.speak(`Here's ${entry.title}.`);
  }

  onTrackFailed(entry, reason) {
    const asked = entry.asked || entry.title;
    if (entry.via === 'dj') {
      // DJ picks that can't be found are skipped quietly. If nothing at all plays, stop and say why.
      const fails = this.dj.onPickResult(false);
      log.info(`DJ pick "${asked}" unplayable (${reason}); ${fails} in a row`);
      if (fails >= 6 && this.dj.enabled) {
        const why = sources.summary().filter((l) => !/: ok$/.test(l)).join('; ') || reason;
        this.dj.turnOff({ silent: true });
        this.postText(`I couldn't get audio for the last ${fails} DJ picks (${why}), so I stopped the DJ.`);
        this.speak(`I can't get any audio right now, so I stopped the DJ.`);
      }
      return;
    }
    this.postText(`Couldn't play **${asked}**: ${reason}.`);
    const m = entry.requestedBy?.id ? this.guild.members.cache.get(entry.requestedBy.id) : null;
    const line = `I couldn't play ${asked}. ${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
    this.speak(line);
    if (m) this.memory.figSaid(line, m.displayName);
  }

  /** A source started refusing this machine. Say so once, so the room knows why songs take a detour. */
  onSourceDown(source, reason) {
    if (!this.connection) return;
    const other = sources.order().filter((s) => s !== source && sources.isUp(s)).map(sources.label);
    this.postText(`${reason}. ${other.length ? `Using ${other.join(' / ')} for now.` : 'No other source is working right now.'}`);
  }

  /** After a restart or crash, pick the DJ back up if it was on. */
  restoreDj() {
    const saved = store.dj(this.guild.id);
    if (!saved.enabled || this.dj.enabled || this.player.current || this.player.queue.length) return;
    if (!this.humansIn(this.voiceChannel()).length) return; // wait until someone is here
    if (Date.now() - (saved.at || 0) > 12 * 3600 * 1000) return;
    log.info(`restoring DJ (mood "${saved.mood}") after restart`);
    crash.note(`restored DJ mood="${saved.mood}"`);
    this.dj.turnOn(saved.mood);
    this.postText(`DJ's back on: **${saved.mood}**.`);
  }

  // ------------------------------------------------------------------ lifecycle

  checkEmpty() {
    const ch = this.voiceChannel();
    if (!this.connection || !ch) return;
    if (this.isHome(ch) && config.stayInHome) {
      // Stay in the home channel. If it empties, stop the music (no point playing to nobody) but keep
      // the DJ setting so it picks up again when people come back.
      if (this.humansIn(ch).length === 0) {
        if (!this.emptyTimer) {
          this.emptyTimer = setTimeout(() => {
            this.emptyTimer = null;
            const c = this.voiceChannel();
            if (!c || this.humansIn(c).length) return;
            const saved = store.dj(this.guild.id);
            if (this.player.current || this.player.queue.length) {
              log.info('home channel empty; stopping music, staying connected');
              this.player.stop();
              store.setDj(this.guild.id, saved);
            }
          }, config.emptyLeaveSeconds * 1000);
        }
      } else {
        clearTimeout(this.emptyTimer);
        this.emptyTimer = null;
        this.restoreDj();
      }
      return;
    }
    if (this.humansIn(ch).length === 0) {
      if (!this.emptyTimer) {
        this.emptyTimer = setTimeout(() => {
          this.emptyTimer = null;
          const c = this.voiceChannel();
          if (c && this.humansIn(c).length === 0) {
            this.leave({ reason: 'channel empty' });
            this.emit('leftEmpty'); // index.js follows people to wherever they went
          }
        }, config.emptyLeaveSeconds * 1000);
      }
    } else if (this.emptyTimer) {
      clearTimeout(this.emptyTimer);
      this.emptyTimer = null;
    }
  }

  destroy() {
    this.destroyed = true;
    sources.events.off('down', this.onSourceDownBound);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.leave({ reason: 'shutdown' });
    this.player.destroy();
    this.mixer.destroy();
    this.audioPlayer.stop(true);
  }
}

module.exports = { GuildSession, humanMembers };
