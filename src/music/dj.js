'use strict';
// DJ mode: keeps music coming in a named mood without anyone queueing the next song.
//
// The DJ only decides WHAT song comes next ("Bobby Helms - Jingle Bell Rock"). Which upload plays is
// decided by the player when the song is due (music/resolve.js), the same way as a request.
// A DJ pick is refused if:
//   - the song is in the skip memory (any upload, any source) -> skipped songs never come back
//   - the song played recently (DJ_MEMORY_SIZE plays, saved across restarts)
//   - the same song is already queued or playing
// User requests are never blocked by the DJ memory: asking for a song again on purpose is fine.
const { EventEmitter } = require('node:events');
const grok = require('../brain/grok');
const { search } = require('./search');
const { sameSong } = require('./identity');
const store = require('../store');
const { config } = require('../config');
const log = require('../log').logger('dj');

const KEEP_AHEAD = 2; // DJ songs to keep queued behind the current one

class DJ extends EventEmitter {
  constructor({ guildId, player }) {
    super();
    this.guildId = guildId;
    this.player = player;
    player.dj = this;
    this.enabled = false;
    this.mood = '';
    this.pending = []; // ideas not queued yet: { asked } or { asked, track }
    this.refilling = null;
    this.epoch = 0; // bumps on mood change / off, cancels stale refills
    this.failsInRow = 0;
  }

  turnOn(mood) {
    const m = String(mood || '').trim() || this.mood || 'good vibes, crowd-pleasers';
    const changed = !this.enabled || m.toLowerCase() !== this.mood.toLowerCase();
    this.enabled = true;
    this.mood = m;
    this.failsInRow = 0;
    store.setDj(this.guildId, { enabled: true, mood: m });
    if (changed) {
      this.epoch++;
      this.pending = [];
      this.player.queue.removeWhere((e) => {
        if (e.via !== 'dj') return false;
        e.cancelled = true;
        return true;
      });
    }
    log.info(`DJ on mood="${m}" changed=${changed}`);
    if (!this.player.current && !this.player.starting) this.player._startNext('dj-on');
    else this.maybeRefill();
    return this.mood;
  }

  turnOff({ silent = false } = {}) {
    const was = this.enabled;
    this.enabled = false;
    this.epoch++;
    this.pending = [];
    store.setDj(this.guildId, { enabled: false, mood: this.mood });
    const removed = this.player.queue.removeWhere((e) => {
      if (e.via !== 'dj') return false;
      e.cancelled = true;
      return true;
    });
    if (was && !silent) log.info(`DJ off (${removed} queued DJ songs removed)`);
    return was;
  }

  /** The player tells the DJ how its picks went, so a dead mood stops instead of looping. */
  onPickResult(ok) {
    this.failsInRow = ok ? 0 : this.failsInRow + 1;
    return this.failsInRow;
  }

  maybeRefill() {
    if (!this.enabled) return;
    const ahead = this.player.queue.count((e) => e.via === 'dj');
    const userAhead = this.player.queue.length - ahead;
    if (ahead >= KEEP_AHEAD || userAhead >= 3) return;
    this.refill().catch((e) => log.warn('refill failed:', e.message));
  }

  refill({ urgent = false } = {}) {
    if (!this.refilling) {
      this.refilling = this._refill(urgent).finally(() => {
        this.refilling = null;
      });
    }
    return this.refilling;
  }

  /** Why this idea can't be queued, or null. */
  rejectReason(idea) {
    const what = idea.track || idea.asked;
    const skip = this.player._skipReason(idea.track || { title: idea.asked });
    if (skip) return skip;
    if (this.player.playedRecently(what)) return 'played recently';
    const busy = [this.player.current?.entry, ...this.player.queue.items].filter(Boolean);
    if (busy.some((e) => sameSong(what, e.asked) || (e.title && sameSong(what, { title: e.title, channel: e.channel })))) return 'already queued or playing';
    return null;
  }

  async _refill(urgent) {
    const epoch = this.epoch;
    const want = urgent ? 1 : Math.max(0, KEEP_AHEAD - this.player.queue.count((e) => e.via === 'dj'));
    let added = 0;
    let rounds = 0;
    while (added < want && this.enabled && epoch === this.epoch) {
      if (!this.pending.length) {
        if (rounds >= 3) break;
        rounds++;
        await this._suggest(epoch);
        if (epoch !== this.epoch || !this.enabled) return;
        if (!this.pending.length) break;
        continue;
      }
      const idea = this.pending.shift();
      const why = this.rejectReason(idea);
      if (why) {
        log.info(`dj reject "${idea.asked}": ${why}`);
        continue;
      }
      const entry = this.player.makeEntry({
        asked: idea.asked,
        candidates: idea.track ? [idea.track] : [],
        via: 'dj',
        requestedBy: { id: null, name: `DJ (${this.mood})` },
      });
      log.info(`dj enqueue mood="${this.mood}" "${idea.asked}" urgent=${urgent}`);
      this.player.enqueue([entry], { why: 'dj' });
      added++;
      if (urgent) {
        setImmediate(() => this.maybeRefill());
        break;
      }
    }
    if (added === 0 && urgent && this.enabled && epoch === this.epoch) this.emit('stuck', this.mood);
  }

  async _suggest(epoch) {
    const hist = store.history(this.guildId);
    const recent = hist
      .slice(-80)
      .map((h) => h.asked || h.title)
      .filter(Boolean);
    const skipped = store.skipped(this.guildId).map((b) => b.label);
    const queued = this.player.queue.items.map((e) => e.asked);
    const system =
      'You are a club-quality DJ picking songs for friends hanging out in a Discord voice call. ' +
      'Return JSON only: {"songs":[{"artist":"...","title":"..."}]}. Real songs with the exact official artist and title (they are looked up on Spotify). ' +
      'Audio comes from SoundCloud, so lean toward artists who put their music on SoundCloud (independent artists, electronic, hip-hop, remixes) when it fits the mood. ' +
      'Fit the mood closely, vary artists (max one song per artist), mix eras, keep the energy flowing. ' +
      'Never pick anything from the "already played", "skipped" or "queued" lists, and avoid the same few obvious hits.';
    const user =
      `Mood: ${this.mood}\n` +
      `Pick ${config.djBatch} songs.\n` +
      `Already played (do not repeat): ${recent.length ? recent.join(' | ') : 'none'}\n` +
      `Skipped by the room (never pick): ${skipped.length ? skipped.join(' | ') : 'none'}\n` +
      `Queued: ${queued.length ? queued.join(' | ') : 'none'}\n` +
      `Variety seed: ${Math.random().toString(36).slice(2, 8)}`;
    try {
      const data = await grok.chatJson({ system, user, temperature: 1.0 });
      if (epoch !== this.epoch) return;
      const songs = (data?.songs || (Array.isArray(data) ? data : [])).filter((s) => s && s.title);
      this.pending.push(...songs.map((s) => ({ asked: [s.artist, s.title].filter(Boolean).join(' - ') })));
      log.info(`DJ got ${songs.length} ideas for "${this.mood}"`);
    } catch (e) {
      log.warn(`Grok suggestions failed (${e.message}); falling back to search`);
      try {
        const results = await search(`${this.mood} songs`, { limit: 15 });
        if (epoch !== this.epoch) return;
        this.pending.push(...results.sort(() => Math.random() - 0.5).map((track) => ({ asked: track.title, track })));
      } catch (e2) {
        log.warn('fallback search failed:', e2.message);
      }
    }
  }
}

module.exports = { DJ };
