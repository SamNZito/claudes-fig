'use strict';
// Music state for one guild: the current song, the queue, pause, volume.
// Rules this file enforces (from the brief):
//   - A song is only "now playing" once its audio is actually being sent to the channel.
//   - If a song cannot be played we say so and move on; we never pretend.
//   - Skip destroys the current song's processes and buffered audio before anything else happens.
//   - Pause is a user decision. Only resume (or an explicit skip/play-now) clears it.
const { EventEmitter } = require('node:events');
const { TrackSource } = require('../audio/trackSource');
const { Queue } = require('./queue');
const { search, searchSoundCloud, songKey } = require('./search');
const store = require('../store');
const { config } = require('../config');
const log = require('../log').logger('music');

class MusicPlayer extends EventEmitter {
  constructor({ guildId, mixer }) {
    super();
    this.guildId = guildId;
    this.mixer = mixer;
    this.queue = new Queue();
    this.current = null; // { entry, source, status: 'loading'|'playing', resumeTries, recorded }
    this.paused = false;
    this.gen = 0;
    this.dj = null; // set by DJ
    this.volume = store.settings(guildId).volume;
    this.mixer.setVolume(this.volume);
    this.watchdog = setInterval(() => this._watch(), 5000);
    this.watchdog.unref?.();
    this.starting = false;
    this.skipBlock = new Map(); // songKey or id:key -> expires at. Stops a skip from coming back.
  }

  // ---------- requests ----------

  /**
   * Resolve a query and queue it. If nothing is playing, it starts.
   * @returns {Promise<{ok:boolean, error?:string, entries?:object[], position?:number, startsNow?:boolean}>}
   */
  async request(query, { requestedBy = null, playNext = false, playNow = false } = {}) {
    let tracks;
    try {
      tracks = await search(query, { limit: 5 });
    } catch (e) {
      return { ok: false, error: `search failed: ${e.message}` };
    }
    if (!tracks.length) return { ok: false, error: `I couldn't find anything for "${query}"` };
    const isList = tracks.length > 1 && /[?&]list=|\/sets\/|playlist/i.test(query);
    const chosen = isList ? tracks : [tracks[0]];
    const entries = chosen.map((t) => Queue.entry(t, { requestedBy, via: 'user' }));
    if (!isList && entries[0]) {
      entries[0].query = String(query).trim();
      entries[0].altTracks = tracks.slice(1);
      entries[0].asked = entries[0].title;
    }
    // They asked for this on purpose, even if it was skipped earlier.
    for (const e of entries) this._forgetSkip(e);
    this._forgetSkip(query);
    const alreadyPlaying = Boolean(this.current);
    log.info(
      `request by=${requestedBy?.name || '-'} query="${String(query).slice(0, 140)}" playNext=${playNext} playNow=${playNow} ` +
        `already="${this.current?.entry?.title || 'nothing'}" chosen="${entries.map((e) => e.title).join(' | ')}" alts=${entries[0]?.altTracks?.length || 0}`,
    );
    const res = this.enqueue(entries, { front: playNext || playNow, why: 'user-request' });
    // Idle: enqueue already started this song. Skip only if a different song was playing.
    if (playNow && alreadyPlaying) this.skip({ reason: 'play now' });
    return { ok: true, entries, ...res };
  }

  enqueue(entries, { front = false, why = 'enqueue' } = {}) {
    const wasIdle = !this.current;
    this.queue.add(entries, { front });
    const position = front ? 1 : this.queue.length - entries.length + 1;
    log.info(
      `enqueue why=${why} front=${front} idle=${wasIdle} starting=${this.starting} +${entries.length} ` +
        `[${entries.map((e) => `${e.via}:${e.title}`).join(' | ')}] queueNow=${this._queueBrief()}`,
    );
    // A start already in progress (skip/end waiting on the DJ) will take the new item.
    // Starting again here is what replayed a song that had just been skipped.
    if (wasIdle && !this.starting) this._startNext('queue-idle');
    return { startsNow: wasIdle && !this.starting, position: wasIdle ? 0 : position };
  }

  skip({ reason = 'skipped' } = {}) {
    const cur = this.current;
    if (!cur) {
      log.info(`skip ignored reason=${reason} (nothing current) queue=${this._queueBrief()}`);
      return null;
    }
    const e = cur.entry;
    this._blockSong(e);
    this._recordHistory(cur, reason);
    log.info(
      `skip reason=${reason} title="${e.title}" uid=${e.uid} key=${e.key} via=${e.via} by=${e.requestedBy?.name || '-'} ` +
        `status=${cur.status} pos=${Math.round((cur.source?.positionMs || 0) / 1000)}s next="${this.queue.items[0]?.title || 'empty'}" queue=${this._queueBrief()}`,
    );
    this.paused = false; // skipping is a request to hear the next song
    this.mixer.setMusicPaused(false);
    this._startNext('skip');
    return e;
  }

  pause() {
    if (this.paused) return false;
    this.paused = true;
    this.mixer.setMusicPaused(true);
    return true;
  }

  resume() {
    if (!this.paused) return false;
    this.paused = false;
    this.mixer.setMusicPaused(false);
    if (!this.current && this.queue.length) this._startNext('resume-unpause');
    return true;
  }

  /** Stop everything: current song, queue, DJ. */
  stop() {
    this.gen++;
    const had = Boolean(this.current) || this.queue.length > 0;
    if (this.current) this._recordHistory(this.current, 'stopped');
    this._dropCurrent();
    this.queue.clear();
    this.paused = false;
    this.mixer.setMusicPaused(false);
    if (this.dj) this.dj.turnOff({ silent: true });
    return had;
  }

  /** Remove upcoming songs; the current one keeps playing. */
  clearQueue() {
    return this.queue.clear();
  }

  remove(target) {
    const n = Number(target);
    if (Number.isInteger(n) && String(target).trim() === String(n)) return this.queue.removeAt(n);
    return this.queue.removeMatching(target);
  }

  shuffle() {
    this.queue.shuffle();
    return this.queue.length;
  }

  setVolume(v) {
    const prev = this.volume;
    this.volume = Math.max(0, Math.min(100, Math.round(v)));
    this.mixer.setVolume(this.volume);
    store.updateSettings(this.guildId, { volume: this.volume });
    log.info(`volume ${prev} -> ${this.volume} (music keeps playing: ${this.current ? this.current.entry.title : 'nothing'})`);
    return this.volume;
  }

  // ---------- views ----------

  nowPlaying() {
    if (!this.current) return null;
    return {
      entry: this.current.entry,
      status: this.current.status,
      paused: this.paused,
      positionSec: Math.floor((this.current.source?.positionMs || 0) / 1000),
    };
  }

  isAudible() {
    return Boolean(this.current && this.current.status === 'playing' && !this.paused);
  }

  describe(limit = 10) {
    const lines = [];
    const np = this.nowPlaying();
    if (np) {
      const state = np.status === 'loading' ? 'loading' : np.paused ? 'paused' : 'playing';
      lines.push(`Now (${state}): ${fmtEntry(np.entry)} [${fmtTime(np.positionSec)}/${fmtTime(np.entry.duration)}]`);
    } else lines.push('Nothing playing.');
    this.queue.items.slice(0, limit).forEach((e, i) => lines.push(`${i + 1}. ${fmtEntry(e)}`));
    if (this.queue.length > limit) lines.push(`...and ${this.queue.length - limit} more`);
    if (this.dj?.enabled) lines.push(`DJ is on (mood: ${this.dj.mood}).`);
    lines.push(`Volume ${this.volume}%.`);
    return lines.join('\n');
  }

  // ---------- engine ----------

  _dropCurrent() {
    const cur = this.current;
    this.current = null;
    if (cur?.source) cur.source.destroy();
    this.mixer.setMusic(null);
  }

  async _startNext(why = 'advance') {
    if (this.starting) {
      log.info(`startNext why=${why} skipped (a start is already in progress) gen=${this.gen}`);
      return;
    }
    this.starting = true;
    try {
      const gen = ++this.gen;
      this._dropCurrent();
      let entry = this.queue.shift();
      while (entry && this._skipBlocked(entry)) {
        log.info(`startNext why=${why} dropped skipped "${entry.title}" key=${entry.key} via=${entry.via} uid=${entry.uid}`);
        entry = this.queue.shift();
      }
      if (!entry && this.dj?.enabled) {
        log.info(`startNext why=${why} queue empty, asking DJ mood="${this.dj.mood}"`);
        try {
          await this.dj.refill({ urgent: true });
        } catch (e) {
          log.warn('DJ refill failed:', e.message);
        }
        if (gen !== this.gen) {
          log.info(`startNext why=${why} aborted after DJ refill (gen ${gen} -> ${this.gen})`);
          return;
        }
        entry = this.queue.shift();
        while (entry && this._skipBlocked(entry)) {
          log.info(`startNext why=${why} dropped skipped DJ pick "${entry.title}" key=${entry.key}`);
          entry = this.queue.shift();
        }
      }
      if (!entry) {
        log.info(`startNext why=${why} nothing to play`);
        this.emit('idle');
        return;
      }
      log.info(
        `startNext why=${why} gen=${gen} title="${entry.title}" key=${entry.key} via=${entry.via} by=${entry.requestedBy?.name || '-'} ` +
          `query="${entry.query || ''}" queueLeft=${this._queueBrief()}`,
      );
      this._startEntry(entry, { gen, why });
      if (this.dj?.enabled) this.dj.maybeRefill();
    } finally {
      this.starting = false;
    }
  }

  _startEntry(entry, { gen = this.gen, startSec = 0, resumeTries = 0, why = 'start' } = {}) {
    const blocked = this._skipBlocked(entry);
    if (blocked && why !== 'user-request') {
      log.info(`refuse why=${why} skipped song "${entry.title}" (${blocked}) key=${entry.key} via=${entry.via}`);
      this._startNext(`blocked-${why}`);
      return;
    }
    const prev = this.current;
    if (prev?.source) prev.source.destroy();
    const source = new TrackSource(entry, { startSec });
    const cur = { entry, source, status: 'loading', resumeTries, recorded: false, loadingSince: Date.now() };
    this.current = cur;
    const stale = () => this.current !== cur || gen !== this.gen;

    source.on('started', () => {
      if (stale()) return;
      cur.status = 'playing';
      if (startSec === 0) {
        this._recordHistory(cur, 'played');
        this.emit('nowPlaying', entry);
      } else {
        log.info(`resumed "${entry.title}" at ${Math.round(startSec)}s`);
      }
    });
    source.on('failed', (reason) => {
      if (stale()) return;
      if (startSec > 0) {
        log.warn(`resume of "${entry.title}" failed (${reason}); moving on`);
        this.emit('trackCut', entry, reason);
        this._startNext('resume-failed');
        return;
      }
      this._recordHistory(cur, 'failed');
      if (!entry.originReason) entry.originReason = reason;
      if (this._youtubeWide(reason)) this.youtubeDown = true;
      if (this._canFallback(entry, reason)) {
        this._runFallback(entry, gen, reason);
        return;
      }
      this._failHeard(entry, reason);
      this._startNext('track-failed');
    });
    source.on('ended', ({ early, positionMs, reason }) => {
      if (stale()) return;
      const played = positionMs / 1000;
      const dur = Number(entry.duration) || 0;
      log.info(
        `stream end title="${entry.title}" key=${entry.key} played=${Math.round(played)}s catalog=${dur}s early=${early} reason=${reason || '-'}`,
      );
      // SoundCloud "full" results are often a 30s preview. That is not the song ending.
      const short = played >= 1 && played < 55 && !entry.triedLonger && (dur === 0 || dur < 75 || dur > played + 15);
      if (short) {
        entry.triedLonger = true;
        log.warn(`"${entry.title}" stopped after ${Math.round(played)}s (catalog ${dur}s); looking for a full copy`);
        this._playAnother(entry, gen);
        return;
      }
      if (early && positionMs > 45000 && resumeTries < 2) {
        log.warn(`"${entry.title}" cut off at ${Math.round(played)}s (${reason}); resuming why=early-end`);
        this._startEntry(entry, { gen, startSec: Math.max(0, played - 1), resumeTries: resumeTries + 1, why: 'early-end' });
        return;
      }
      if (early) log.info(`"${entry.title}" ended after ${Math.round(played)}s why=ended; next song`);
      this._startNext('ended');
    });

    this.mixer.setMusic(source.pcm);
    source.start();
  }

  _recordHistory(cur, how) {
    if (cur.recorded) return;
    cur.recorded = true;
    const e = cur.entry;
    store.addHistory(this.guildId, { id: e.key, key: songKey(e.title), title: e.title, via: e.via, how });
  }

  _failHeard(entry, reason) {
    // Don't blame the song for whatever the last bad upload did. The first failure is the real one.
    const shown = entry.originReason || reason;
    this.emit('trackFailed', { ...entry, title: entry.asked || entry.title }, shown);
  }

  _canFallback(entry, reason) {
    if (!/sign-in|403|no audio|unavailable|timed out|refused|drm|never started|age-restricted|copyright/i.test(reason)) return false;
    if (this._nextFallback(entry, reason)) return true;
    return false;
  }

  /** A sign-in, 403, or empty format list is this server, not this one upload. */
  _youtubeWide(reason) {
    return /sign-in|403|refused|no audio/i.test(reason);
  }

  _altsFor(entry, reason) {
    const alts = entry.altTracks || [];
    if (!this._youtubeWide(reason)) return alts;
    return alts.filter((t) => /soundcloud/i.test(`${t.key || ''} ${t.url || ''}`));
  }

  _nextFallback(entry, reason) {
    if (this._altsFor(entry, reason).length) return 'alt';
    const onSc = /soundcloud/i.test(`${entry.key || ''} ${entry.url || ''}`);
    if (entry.query && !entry.triedSc && !onSc) return 'soundcloud';
    return null;
  }

  /** YouTube often refuses the file. Try another upload, then SoundCloud, before telling the call. */
  async _runFallback(entry, gen, reason) {
    if (gen !== this.gen) return;
    let next = null;
    let altTracks = this._altsFor(entry, reason);
    let triedSc = Boolean(entry.triedSc);
    if (altTracks.length) {
      next = altTracks[0];
      altTracks = altTracks.slice(1);
    } else if (this._nextFallback(entry, reason) === 'soundcloud') {
      triedSc = true;
      try {
        const queries = this._scQueries(entry);
        const found = [];
        for (const q of queries) {
          if (gen !== this.gen) return;
          const sc = await searchSoundCloud(q, { limit: 5 });
          for (const t of sc) {
            const score = this._songScore(entry, t);
            if (score > 0 && !found.some((f) => f.track.key === t.key)) found.push({ track: t, score });
          }
          if (found.length) break;
        }
        if (gen !== this.gen) return;
        found.sort((a, b) => {
          const long = (t) => (t.track.duration >= 75 ? 1 : 0);
          const d = long(b) - long(a);
          return d || b.score - a.score;
        });
        if (!found.length) log.info(`soundcloud had no usable copy for "${queries[0] || entry.query}"`);
        next = found[0]?.track || null;
        altTracks = found.slice(1).map((f) => f.track);
        log.info(
          `soundcloud candidates ${found.slice(0, 4).map((f) => `"${f.track.title}" ${f.track.duration || 0}s`).join(' | ') || 'none'}`,
        );
      } catch (e) {
        log.warn(`soundcloud fallback failed: ${e.message}`);
      }
    }
    if (!next || gen !== this.gen) {
      this._failHeard(entry, reason);
      if (gen === this.gen) this._startNext('fallback-exhausted');
      return;
    }
    const e = Queue.entry(next, { requestedBy: entry.requestedBy, via: entry.via });
    e.query = entry.query;
    e.asked = entry.asked || entry.title;
    e.originReason = entry.originReason || reason;
    e.altTracks = altTracks;
    e.triedSc = triedSc;
    e.triedLonger = Boolean(entry.triedLonger);
    log.info(`fallback why=${reason} from="${entry.title}" key=${entry.key} dur=${entry.duration || 0}s to="${e.title}" toDur=${e.duration || 0}s toKey=${e.key} via=${e.via} query="${e.query || ''}"`);
    this._startEntry(e, { gen, why: 'fallback' });
  }

  /** The copy that just played was a preview. Find a longer one before giving up. */
  async _playAnother(entry, gen) {
    if (gen !== this.gen) return;
    const tried = new Set([entry.key, ...(entry.triedIds || [])].filter(Boolean));
    let results = [];
    try {
      if (entry.query) results = await searchSoundCloud(entry.query, { limit: 8 });
    } catch (e) {
      log.warn(`longer-copy search failed: ${e.message}`);
    }
    if (gen !== this.gen) return;
    const fresh = results.filter((t) => t && !tried.has(t.key));
    const next = fresh.find((t) => t.duration >= 75) || fresh.find((t) => !t.duration || t.duration >= 50) || null;
    if (!next) {
      log.info(`no longer copy of "${entry.asked || entry.title}" (played key=${entry.key}). queue=${this._queueBrief()}`);
      this._startNext('short-ended');
      return;
    }
    const e = Queue.entry(next, { requestedBy: entry.requestedBy, via: entry.via });
    e.query = entry.query;
    e.asked = entry.asked || entry.title;
    e.triedIds = [...tried, next.key];
    e.triedLonger = true;
    e.triedSc = true;
    log.info(`longer copy of "${entry.title}" -> "${e.title}" ${e.duration || 0}s key=${e.key}`);
    this._startEntry(e, { gen, why: 'longer-copy' });
  }

  _words(s) {
    const skip = new Set(['the', 'and', 'sings', 'feat', 'official', 'video', 'audio', 'edition', 'lyrics', 'ver', 'version']);
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length > 2 && !skip.has(w));
  }

  /** Extra SoundCloud searches. The YouTube title is often not what the upload is called. */
  _scQueries(entry) {
    const raw = [entry.query, entry.asked, entry.title].filter(Boolean).join(' ');
    const out = [];
    const add = (s) => {
      const t = String(s || '').replace(/\s+/g, ' ').trim();
      if (t && !/^https?:/i.test(t) && !out.includes(t)) out.push(t);
    };
    add(entry.query);
    for (const m of raw.matchAll(/\(([^)]+)\)|\[([^\]]+)\]|【([^】]+)】/g)) add(m[1] || m[2] || m[3]);
    const words = this._words(raw);
    const extra = words.filter((w) => w !== 'monster' && w !== 'mash');
    if (words.includes('monster') && words.includes('mash')) {
      if (extra.includes('brainrot')) add('brainrot monster mash');
      if (extra.includes('mint')) add('mint monster mash');
      if (extra.length) add(`${extra.slice(0, 2).join(' ')} monster mash`);
    }
    return out.slice(0, 4);
  }

  /** How close a SoundCloud title is. 0 means a different song. Parentheses count. */
  _songScore(entry, track) {
    const hay = this._words(`${track.title} ${track.channel || ''}`);
    const want = this._words([entry.query, entry.asked, entry.title].filter(Boolean).join(' '));
    if (!want.length || !hay.length) return 0;
    const hits = want.filter((w) => hay.includes(w));
    const distinctive = want.filter((w) => !['monster', 'mash', 'song', 'songs'].includes(w));
    if (distinctive.length && !distinctive.some((w) => hay.includes(w))) return 0;
    if (hits.length < Math.min(2, want.length)) return 0;
    return hits.length;
  }

  _watch() {
    const cur = this.current;
    if (!cur?.source) return;
    if (cur.status === 'loading') {
      if (cur.source.pcm.received > 0) this.mixer.wake();
      const limitMs = (config.trackStartTimeoutSec + 5) * 1000;
      if (!cur.source.done && Date.now() - cur.loadingSince > limitMs) {
        log.warn(`"${cur.entry.title}" stuck loading`);
        cur.source.fail(cur.source.pcm.received ? 'audio never started' : `timed out after ${config.trackStartTimeoutSec}s waiting for audio`);
      }
      return;
    }
    if (cur.source.checkStall(!this.paused && cur.status === 'playing')) {
      const pos = cur.source.positionMs;
      log.warn(`"${cur.entry.title}" stalled at ${Math.round(pos / 1000)}s; restarting (try ${cur.resumeTries + 1})`);
      cur.source.destroy();
      if (cur.resumeTries < 2) this._startEntry(cur.entry, { gen: this.gen, startSec: pos / 1000, resumeTries: cur.resumeTries + 1, why: 'stall' });
      else {
        this.emit('trackCut', cur.entry, 'the stream kept stalling');
        this._startNext('stall-give-up');
      }
    }
  }

  _queueBrief() {
    return this.queue.items.slice(0, 6).map((e) => `${e.via}:${e.title}`).join(' | ') || 'empty';
  }

  _blockSong(entry) {
    const until = Date.now() + 30 * 60 * 1000;
    if (entry.key) this.skipBlock.set(`id:${entry.key}`, until);
    for (const raw of [entry.title, entry.asked, entry.query]) {
      const k = songKey(raw);
      if (k) this.skipBlock.set(k, until);
    }
  }

  _forgetSkip(entryOrQuery) {
    const raw = typeof entryOrQuery === 'string' ? entryOrQuery : entryOrQuery?.title;
    const k = songKey(raw);
    if (k) this.skipBlock.delete(k);
    const id = typeof entryOrQuery === 'object' && entryOrQuery?.key ? `id:${entryOrQuery.key}` : null;
    if (id) this.skipBlock.delete(id);
  }

  /** @returns {string|null} why this entry is a song that was just skipped */
  _skipBlocked(entry) {
    const now = Date.now();
    for (const [k, exp] of this.skipBlock) if (exp <= now) this.skipBlock.delete(k);
    if (!entry) return null;
    if (entry.key && this.skipBlock.has(`id:${entry.key}`)) return `id ${entry.key}`;
    for (const raw of [entry.title, entry.asked, entry.query]) {
      const k = songKey(raw);
      if (k && this.skipBlock.has(k)) return `title "${k}"`;
    }
    return null;
  }

  destroy() {
    clearInterval(this.watchdog);
    this.gen++;
    this._dropCurrent();
    this.queue.clear();
  }
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function fmtEntry(e) {
  const who = e.via === 'dj' ? 'DJ' : e.requestedBy?.name || 'someone';
  return `${e.title}${e.channel ? ` - ${e.channel}` : ''} (${fmtTime(e.duration)}, ${who})`;
}

module.exports = { MusicPlayer, fmtTime, fmtEntry };
