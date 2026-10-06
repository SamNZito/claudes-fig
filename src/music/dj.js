'use strict';
// DJ mode: keeps music coming in a named mood without anyone queueing the next song.
// It has a memory (persisted per guild) of what has played, so it does not loop the same set.
// User requests are never blocked by that memory: asking for a song again on purpose is fine.
const { EventEmitter } = require('node:events');
const grok = require('../brain/grok');
const { search, searchSoundCloud, songKey, playable } = require('./search');
const { Queue } = require('./queue');
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
    this.pending = []; // suggestions not resolved yet: { artist, title } or { track }
    this.refilling = null;
    this.epoch = 0; // bumps on mood change / off, cancels stale refills
  }

  turnOn(mood) {
    const m = String(mood || '').trim() || this.mood || 'good vibes, crowd-pleasers';
    const changed = !this.enabled || m.toLowerCase() !== this.mood.toLowerCase();
    this.enabled = true;
    this.mood = m;
    if (changed) {
      this.epoch++;
      this.pending = [];
      this.player.queue.removeWhere((e) => e.via === 'dj');
    }
    if (!this.player.current) this.player._startNext();
    else this.maybeRefill();
    return this.mood;
  }

  turnOff({ silent = false } = {}) {
    const was = this.enabled;
    this.enabled = false;
    this.epoch++;
    this.pending = [];
    const removed = this.player.queue.removeWhere((e) => e.via === 'dj');
    if (was && !silent) log.info(`DJ off (${removed} queued DJ songs removed)`);
    return was;
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

  memory() {
    const hist = store.history(this.guildId);
    const ids = new Set(hist.map((h) => h.id));
    const keys = new Set(hist.slice(-150).map((h) => h.key).filter(Boolean));
    return { hist, ids, keys };
  }

  async _refill(urgent) {
    const epoch = this.epoch;
    const want = urgent ? 1 : KEEP_AHEAD - this.player.queue.count((e) => e.via === 'dj');
    let added = 0;
    let tries = 0;
    let suggestRounds = 0;
    while (added < want && tries < 16 && this.enabled && epoch === this.epoch) {
      if (!this.pending.length) {
        if (suggestRounds >= 3) break;
        suggestRounds++;
        await this._suggest(epoch);
        if (!this.pending.length) break;
        continue;
      }
      tries++;
      const cand = this.pending.shift();
      const track = await this._resolve(cand);
      if (epoch !== this.epoch || !this.enabled) return;
      if (!track) {
        log.info(`dj reject "${cand.artist || ''} - ${cand.title || cand.track?.title || '?'}" (played, skipped, queued, or no playable copy)`);
        continue;
      }
      const entry = Queue.entry(track, { via: 'dj', requestedBy: { id: null, name: `DJ (${this.mood})` } });
      // Kept so a YouTube block can look the same song up on SoundCloud instead of killing the DJ.
      entry.query = cand.track ? track.title : `${cand.artist || ''} - ${cand.title}`.replace(/^\s*-\s*/, '').trim();
      entry.asked = track.title;
      log.info(`dj enqueue mood="${this.mood}" title="${entry.title}" key=${entry.key} query="${entry.query}" urgent=${urgent}`);
      this.player.enqueue([entry], { why: 'dj' });
      added++;
      // Once one song is queued, start the next ones in the background so music starts sooner.
      if (urgent && added >= 1) {
        setImmediate(() => this.maybeRefill());
        break;
      }
    }
    if (added === 0 && urgent && this.enabled && epoch === this.epoch) {
      this.emit('stuck', this.mood);
    }
  }

  async _resolve(cand) {
    const { ids, keys } = this.memory();
    const inPlay = new Set([...this.player.queue.items.map((e) => e.key), this.player.current?.entry?.key].filter(Boolean));
    const inPlayKeys = new Set([...this.player.queue.items.map((e) => songKey(e.title)), songKey(this.player.current?.entry?.title)].filter(Boolean));
    const ok = (t) =>
      t && playable(t) && (!t.duration || t.duration >= 60) && !ids.has(t.key) && !inPlay.has(t.key) && !keys.has(songKey(t.title)) && !inPlayKeys.has(songKey(t.title));
    if (cand.track) return ok(cand.track) ? cand.track : null;
    const q = `${cand.artist} - ${cand.title}`;
    if (keys.has(songKey(cand.title)) || keys.has(songKey(q))) return null;
    try {
      // YouTube downloads from this server die immediately and the DJ then
      // flips through old songs. Prefer a source that actually plays.
      let results = await searchSoundCloud(q, { limit: 4 });
      if (!results.length) results = await search(`${q} audio`, { limit: 3 });
      return results.find(ok) || null;
    } catch (e) {
      log.debug(`resolve failed for ${q}: ${e.message}`);
      return null;
    }
  }

  async _suggest(epoch) {
    const { hist } = this.memory();
    const recent = hist
      .slice(-80)
      .map((h) => h.title)
      .filter(Boolean);
    const queued = this.player.queue.items.map((e) => e.title);
    const system =
      'You are a club-quality DJ picking songs for friends hanging out in a Discord voice call. ' +
      'Return JSON only: {"songs":[{"artist":"...","title":"..."}]}. Real, well-known-enough songs that exist on YouTube. ' +
      'Fit the mood closely, vary artists (max one song per artist), mix eras, keep the energy flowing. ' +
      'Never pick anything from the "already played" or "queued" lists, and avoid obvious repeats of the same few hits.';
    const user =
      `Mood: ${this.mood}\n` +
      `Pick ${config.djBatch} songs.\n` +
      `Already played (do not repeat): ${recent.length ? recent.join(' | ') : 'none'}\n` +
      `Queued: ${queued.length ? queued.join(' | ') : 'none'}\n` +
      `Variety seed: ${Math.random().toString(36).slice(2, 8)}`;
    try {
      const data = await grok.chatJson({ system, user, temperature: 1.0 });
      if (epoch !== this.epoch) return;
      const songs = (data?.songs || data || []).filter((s) => s && s.title);
      this.pending.push(...songs.map((s) => ({ artist: String(s.artist || ''), title: String(s.title) })));
      log.info(`DJ got ${songs.length} ideas for "${this.mood}"`);
    } catch (e) {
      log.warn(`Grok suggestions failed (${e.message}); falling back to search`);
      try {
        const results = await search(`${this.mood} songs`, { limit: 15 });
        if (epoch !== this.epoch) return;
        this.pending.push(...results.sort(() => Math.random() - 0.5).map((track) => ({ track })));
      } catch (e2) {
        log.warn('fallback search failed:', e2.message);
      }
    }
  }
}

module.exports = { DJ };
