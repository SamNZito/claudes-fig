'use strict';
// Music state for one guild: the current request, the queue, pause, volume.
//
// Model
//   A queue entry is a REQUEST ("please come home for christmas", or a DJ pick). Which upload plays
//   is decided only when it is about to play (music/resolve.js probes copies until one really works).
//   Retrying another copy, or resuming the same copy after a network cut, happens inside the same
//   request. Nothing ever re-queues or restarts a request from the outside.
//
// Rules this file enforces
//   - "Now playing" only once audio is actually pulled into the channel.
//   - A copy that stops after a few seconds (preview, bad file) is a bad copy, not "the song ended":
//     another copy is tried. If none plays, the call is told why.
//   - Skip cancels the request (every pending retry/resume/fallback checks `cancelled`), destroys
//     the audio, and remembers the SONG (any upload, any source) so nothing automatic plays it again
//     for SKIP_BLOCK_HOURS. Asking for it again on purpose lifts that.
//   - Pause is a user decision. Only resume / skip clears it. Volume never touches playback.
const { EventEmitter } = require('node:events');
const { TrackSource } = require('../audio/trackSource');
const { Queue } = require('./queue');
const { songKey } = require('./search');
const { lookup } = require('./lookup');
const { findPlayable, probe, fresh } = require('./resolve');
const { sameSong } = require('./identity');
const sources = require('./sources');
const store = require('../store');
const { config } = require('../config');
const log = require('../log').logger('music');

const MAX_COPIES_PER_REQUEST = 5;

class MusicPlayer extends EventEmitter {
  constructor({ guildId, mixer }) {
    super();
    this.guildId = guildId;
    this.mixer = mixer;
    this.queue = new Queue();
    this.current = null; // { entry, status: 'resolving'|'loading'|'playing', source, track, probe, resumeTries, gen }
    this.paused = false;
    this.gen = 0;
    this.starting = false;
    this.dj = null; // set by DJ
    this.volume = store.settings(guildId).volume;
    this.mixer.setVolume(this.volume);
    this.watchdog = setInterval(() => this._watch(), 5000);
    this.watchdog.unref?.();
  }

  // =====================================================================================
  // requests
  // =====================================================================================

  /**
   * Build a queue entry for a request. `meta` is the real song from Spotify (artist/title/length);
   * `candidates` are uploads already found. Either may be missing: resolve.js fills in the rest.
   */
  makeEntry({ asked, candidates = [], via = 'user', requestedBy = null, explicit = false, pinned = null, meta = null, typed = null }) {
    const first = candidates[0] || {};
    const e = Queue.entry(
      {
        key: meta?.spotifyId ? `spotify:${meta.spotifyId}` : first.key || `ask:${String(asked).toLowerCase()}`,
        id: meta?.spotifyId || first.id || null,
        url: meta?.url || first.url || null,
        title: meta?.title || (via === 'dj' || !first.title ? asked : first.title),
        channel: meta?.artist || first.channel || '',
        duration: meta?.durationSec || first.duration || 0,
      },
      { requestedBy, via },
    );
    return Object.assign(e, {
      asked: String(asked || meta?.asked || first.title || '').trim(),
      typed,
      meta,
      candidates: [...candidates],
      tried: new Set(),
      explicit,
      pinned,
      copies: 0,
      resolved: null,
      cancelled: false,
    });
  }

  /**
   * Someone asked for something. Look it up (Spotify / SoundCloud), queue it (never interrupts the
   * current song), start if idle.
   * @returns {Promise<{ok:boolean, error?:string, entries?:object[], position?:number, startsNow?:boolean}>}
   */
  async request(query, { requestedBy = null, playNext = false, playNow = false } = {}) {
    const q = String(query || '').trim();
    const found = await lookup(q);
    if (!found.ok) return { ok: false, error: found.error };
    const entries = found.items.map((it) =>
      this.makeEntry({ asked: it.asked, meta: it.meta || null, candidates: it.candidates || [], pinned: it.pinned || null, typed: it.typed || null, requestedBy, explicit: true }),
    );
    // Asked for on purpose: a previous skip of this song no longer applies.
    for (const e of entries) this.unblock(e);
    log.info(
      `request by=${requestedBy?.name || '-'} query="${q.slice(0, 140)}" via=${found.source} -> ${entries.length} song(s): ` +
        `${entries.slice(0, 3).map((e) => `"${e.asked}"${e.meta?.durationSec ? ` ${e.meta.durationSec}s` : ''}`).join(', ')} current="${this.current?.entry?.asked || 'nothing'}"`,
    );
    const wasPlaying = Boolean(this.current);
    const res = this.enqueue(entries, { front: playNext || playNow, why: 'user-request' });
    // /play when:now (slash command only). Voice requests never do this. Not a skip of a song they dislike, so no block.
    if (playNow && wasPlaying) this.skip({ reason: 'play now', block: false });
    return { ok: true, entries, ...res };
  }

  /** Accept a bare track too (older callers / tests): wrap it as a request for exactly that track. */
  _normalize(e) {
    if (e && e.tried instanceof Set && 'asked' in e) return e;
    const entry = this.makeEntry({ asked: e.asked || e.title, candidates: e.url ? [e] : [], via: e.via || 'user', requestedBy: e.requestedBy || null, explicit: e.via !== 'dj' });
    return entry;
  }

  enqueue(entries, { front = false, why = 'enqueue' } = {}) {
    entries = entries.map((e) => this._normalize(e));
    const idle = !this.current && !this.starting;
    this.queue.add(entries, { front });
    const position = front ? 1 : this.queue.length - entries.length + 1;
    log.info(`enqueue why=${why} front=${front} idle=${idle} +[${entries.map((e) => `${e.via}:${e.asked}`).join(' | ')}] queue=${this._queueBrief()}`);
    if (idle) this._startNext(why);
    else if (this.current?.status === 'playing') this._prefetch();
    return { startsNow: idle, position: idle ? 0 : position };
  }

  /**
   * Skip what's playing (or loading). The song is gone: its request is cancelled, its audio dropped,
   * and it may not come back from the DJ, a fallback copy, or a queued duplicate.
   */
  skip({ reason = 'skipped', block = true } = {}) {
    const cur = this.current;
    if (!cur) {
      log.info(`skip ignored reason=${reason} (nothing current, starting=${this.starting}) queue=${this._queueBrief()}`);
      return null;
    }
    const e = cur.entry;
    e.cancelled = true;
    if (block) this._block(e, cur.track);
    this._recordHistory(cur, reason);
    let dropped = 0;
    if (block) {
      dropped = this.queue.removeWhere((q) => {
        const hit = Boolean(this._skipReason(q));
        if (hit) q.cancelled = true;
        return hit;
      });
    }
    log.info(
      `skip reason=${reason} asked="${e.asked}" playing="${cur.track?.title || '-'}" key=${cur.track?.key || e.key} via=${e.via} ` +
        `status=${cur.status} pos=${Math.round((cur.source?.positionMs || 0) / 1000)}s droppedDupes=${dropped} next="${this.queue.items[0]?.asked || 'empty'}"`,
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
    log.info(`pause "${this.current?.entry?.asked || '-'}"`);
    return true;
  }

  resume() {
    if (!this.paused) return false;
    this.paused = false;
    this.mixer.setMusicPaused(false);
    log.info(`resume "${this.current?.entry?.asked || '-'}"`);
    if (!this.current && this.queue.length) this._startNext('resume-unpause');
    return true;
  }

  /** Stop everything: current song, queue, DJ. */
  stop() {
    this.gen++;
    const had = Boolean(this.current) || this.queue.length > 0;
    if (this.current) {
      this.current.entry.cancelled = true;
      this._recordHistory(this.current, 'stopped');
    }
    this._dropCurrent();
    for (const e of this.queue.items) e.cancelled = true;
    this.queue.clear();
    this.paused = false;
    this.mixer.setMusicPaused(false);
    if (this.dj) this.dj.turnOff({ silent: true });
    log.info('stop: music stopped, queue cleared, DJ off');
    return had;
  }

  /** Remove upcoming songs; the current one keeps playing. */
  clearQueue() {
    for (const e of this.queue.items) e.cancelled = true;
    return this.queue.clear();
  }

  remove(target) {
    const n = Number(target);
    const gone = Number.isInteger(n) && String(target).trim() === String(n) ? this.queue.removeAt(n) : this.queue.removeMatching(target);
    if (gone) gone.cancelled = true;
    return gone;
  }

  shuffle() {
    this.queue.shuffle();
    return this.queue.length;
  }

  /** Changes loudness only. Never stops, restarts, or affects the song. */
  setVolume(v) {
    const prev = this.volume;
    this.volume = Math.max(0, Math.min(100, Math.round(v)));
    this.mixer.setVolume(this.volume);
    store.updateSettings(this.guildId, { volume: this.volume });
    log.info(`volume ${prev} -> ${this.volume} (playback untouched: ${this.current ? `${this.current.status} "${this.current.entry.asked}"` : 'nothing'})`);
    return this.volume;
  }

  // =====================================================================================
  // skip memory
  // =====================================================================================

  _block(entry, track) {
    const titles = [];
    if (track) titles.push({ title: track.title, channel: track.channel || '' });
    if (entry.title && (!track || entry.title !== track.title)) titles.push({ title: entry.title, channel: entry.channel || '' });
    if (entry.meta) titles.push({ title: entry.meta.title, channel: entry.meta.artists.join(' ') });
    const keys = new Set(
      [...(entry.tried || []), track?.key, entry.key, entry.meta?.spotifyId ? `spotify:${entry.meta.spotifyId}` : null].filter((k) => k && !k.startsWith('ask:')),
    );
    const block = {
      asks: [entry.asked].filter(Boolean),
      titles,
      keys: [...keys],
      label: entry.asked || track?.title,
      until: Date.now() + config.skipBlockHours * 3600 * 1000,
    };
    store.addSkipped(this.guildId, block);
    log.info(`blocked for ${config.skipBlockHours}h: "${block.label}" keys=${block.keys.join(',') || '-'}`);
  }

  /** Why this entry or track must not play (it was skipped), or null. */
  _skipReason(x) {
    if (!x) return null;
    const isEntry = Boolean(x.uid);
    const texts = isEntry
      ? [x.asked, x.meta ? { title: x.meta.title, channel: x.meta.artists.join(' ') } : null, x.resolved?.track ? x.resolved.track : null].filter(Boolean)
      : [x];
    for (const b of store.skipped(this.guildId)) {
      if (x.key && b.keys.includes(x.key)) return `skipped earlier ("${b.label}")`;
      if (isEntry && x.resolved?.track?.key && b.keys.includes(x.resolved.track.key)) return `skipped earlier ("${b.label}")`;
      if (isEntry && x.meta?.spotifyId && b.keys.includes(`spotify:${x.meta.spotifyId}`)) return `skipped earlier ("${b.label}")`;
      for (const t of texts) {
        for (const bt of b.titles) if (sameSong(t, bt)) return `skipped earlier ("${b.label}")`;
        for (const ba of b.asks) if (sameSong(t, ba)) return `skipped earlier ("${b.label}")`;
      }
    }
    return null;
  }

  /** An explicit request lifts any skip memory of that song. */
  unblock(entry) {
    const list = store.skipped(this.guildId);
    const keep = list.filter((b) => {
      const same =
        b.asks.some((a) => sameSong(entry.asked, a)) ||
        b.titles.some((t) => sameSong(entry.asked, t) || entry.candidates.some((c) => sameSong(c, t))) ||
        entry.candidates.some((c) => b.keys.includes(c.key)) ||
        (entry.meta?.spotifyId && b.keys.includes(`spotify:${entry.meta.spotifyId}`)) ||
        (entry.meta && b.titles.some((t) => sameSong({ title: entry.meta.title, channel: entry.meta.artists.join(' ') }, t)));
      return !same;
    });
    if (keep.length !== list.length) {
      store.setSkipped(this.guildId, keep);
      log.info(`explicit request "${entry.asked}" lifted ${list.length - keep.length} skip block(s)`);
    }
  }

  /** Is this text/track something the DJ already played recently? */
  playedRecently(x, limit = config.djMemorySize) {
    const hist = store.history(this.guildId).slice(-limit);
    for (const h of hist) {
      if (x?.key && h.id === x.key) return true;
      const ht = { title: h.title, channel: h.channel || '' };
      if (sameSong(x, ht)) return true;
      if (h.asked && sameSong(x, h.asked)) return true;
    }
    return false;
  }

  /** Copy-level filter used while resolving. */
  _candidateBlocked(entry, track) {
    const skip = this._skipReason(track);
    if (skip) return skip;
    if (entry.via === 'dj' && this.playedRecently(track)) return 'the DJ already played it';
    return null;
  }

  // =====================================================================================
  // views
  // =====================================================================================

  nowPlaying() {
    if (!this.current) return null;
    const status = this.current.status === 'playing' ? 'playing' : 'loading';
    return {
      entry: this.current.entry,
      status,
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
    const down = sources.summary().filter((l) => !/: ok$/.test(l));
    if (down.length) lines.push(down.join('\n'));
    return lines.join('\n');
  }

  // =====================================================================================
  // engine
  // =====================================================================================

  _dropCurrent() {
    const cur = this.current;
    this.current = null;
    if (cur?.source) cur.source.destroy();
    this.mixer.setMusic(null);
  }

  async _startNext(why = 'advance') {
    if (this.starting) {
      log.info(`startNext why=${why} ignored: a start is already in progress`);
      return;
    }
    this.starting = true;
    let gen;
    let entry = null;
    try {
      gen = ++this.gen;
      this._dropCurrent();
      let refills = 0;
      for (;;) {
        entry = this.queue.shift();
        if (entry) {
          const blocked = this._skipReason(entry);
          if (blocked || entry.cancelled) {
            log.info(`refuse "${entry.asked}" via=${entry.via}: ${blocked || 'cancelled'}`);
            entry.cancelled = true;
            entry = null;
            continue;
          }
          break;
        }
        if (!this.dj?.enabled || refills >= 3) break;
        refills++;
        log.info(`startNext why=${why} queue empty, asking DJ (mood "${this.dj.mood}")`);
        try {
          await this.dj.refill({ urgent: true });
        } catch (e) {
          log.warn('DJ refill failed:', e.message);
        }
        if (gen !== this.gen) {
          log.info(`startNext why=${why} superseded while the DJ was picking`);
          return;
        }
        if (!this.queue.length) break;
      }
      if (!entry) {
        log.info(`startNext why=${why} nothing to play`);
        this.emit('idle');
        return;
      }
      log.info(`startNext why=${why} gen=${gen} asked="${entry.asked}" via=${entry.via} by=${entry.requestedBy?.name || '-'} queueLeft=${this._queueBrief()}`);
      this._play(entry, gen); // sets this.current synchronously
    } finally {
      this.starting = false;
    }
  }

  /**
   * Play a request. Resolves a working copy first unless `resumeOf` says to continue the same copy.
   */
  _play(entry, gen, { startSec = 0, resumeTries = 0, resumeOf = null } = {}) {
    const cur = { entry, status: 'resolving', source: null, track: null, probe: null, resumeTries, gen, recorded: false, since: Date.now() };
    entry.firstPlayAt = entry.firstPlayAt || Date.now();
    this.current = cur;
    const stale = () => this.current !== cur || gen !== this.gen || entry.cancelled;

    (async () => {
      let res = null;
      if (resumeOf) {
        // Same copy, later position (network cut). Re-probe only if the stream URL is too old.
        const p = fresh(resumeOf.probe) ? resumeOf.probe : await probe(resumeOf.track);
        if (stale()) return;
        if (!p.ok) {
          log.warn(`resume of "${entry.asked}" failed: ${p.reason}; next song`);
          this.emit('trackCut', entry, p.reason);
          this._startNext('resume-failed');
          return;
        }
        res = { ok: true, track: resumeOf.track, probe: p };
      } else {
        if (entry.prefetching) await entry.prefetching;
        if (stale()) return;
        if (entry.resolved?.ok && fresh(entry.resolved.probe) && !this._candidateBlocked(entry, entry.resolved.track)) {
          res = entry.resolved;
        } else {
          res = await findPlayable(entry, { blocked: (t) => this._candidateBlocked(entry, t), aborted: stale });
        }
        entry.resolved = null;
      }
      if (stale()) return;
      if (!res.ok) {
        if (res.kind === 'aborted') return;
        this._fail(cur, entry.firstReason || res.reason, res.kind);
        return;
      }
      this._startSource(cur, res, { startSec });
    })().catch((e) => {
      log.error(`play "${entry.asked}" crashed: ${e.stack || e.message}`);
      if (!stale()) this._fail(cur, e.message, 'unknown');
    });
  }

  _startSource(cur, res, { startSec }) {
    const { entry, gen } = cur;
    const track = res.track;
    cur.track = track;
    cur.probe = res.probe;
    cur.status = 'loading';
    entry.copies++;
    // What people see is the copy that is actually playing; what they asked for stays in entry.asked.
    // With Spotify info, show the real song name; otherwise the upload's.
    Object.assign(entry, { key: track.key, id: track.id, url: track.url, duration: track.duration || entry.duration, copyTitle: track.title });
    if (!entry.meta) Object.assign(entry, { title: track.title, channel: track.channel || '' });
    const source = new TrackSource(track, { startSec, infoPath: res.probe.infoPath });
    cur.source = source;
    const stale = () => this.current !== cur || gen !== this.gen || entry.cancelled;
    const src = sources.sourceOf(track);

    source.on('started', () => {
      if (stale()) return;
      cur.status = 'playing';
      sources.markOk(src);
      if (startSec === 0) {
        this._recordHistory(cur, 'played');
        log.info(`now playing "${track.title}" ${track.key} ${Math.round(track.duration || 0)}s for "${entry.asked}" (copy ${entry.copies})`);
        // One announcement per request, even if a bad copy had to be swapped for a good one.
        if (!entry.announced) {
          entry.announced = true;
          this.emit('nowPlaying', entry);
        }
      } else log.info(`resumed "${track.title}" at ${Math.round(startSec)}s`);
      this._prefetch();
    });
    source.on('failed', (reason, kind) => {
      if (stale()) return;
      this._badCopy(cur, reason, kind, { midSong: startSec > 0 });
    });
    source.on('ended', (info) => {
      if (stale()) return;
      this._ended(cur, info);
    });

    this.mixer.setMusic(source.pcm);
    source.start();
  }

  /** This copy didn't work. Try another copy of the SAME request (never the skipped one: we are not stale). */
  _badCopy(cur, reason, kind, { midSong = false } = {}) {
    const { entry, track } = cur;
    entry.tried.add(track.key);
    if (kind === 'blocked') sources.markDown(sources.sourceOf(track), reason);
    if (midSong) {
      log.warn(`"${entry.asked}" could not continue (${reason}); next song`);
      this.emit('trackCut', entry, reason);
      this._startNext('resume-failed');
      return;
    }
    if (!entry.firstReason) entry.firstReason = reason;
    if (kind === 'timeout') entry.timeouts = (entry.timeouts || 0) + 1;
    const tooLong = Date.now() - (entry.firstPlayAt || Date.now()) > 2 * config.resolveBudgetSec * 1000;
    if (kind === 'tooling' || entry.copies >= MAX_COPIES_PER_REQUEST || entry.timeouts >= 2 || tooLong) {
      this._fail(cur, entry.firstReason, kind);
      return;
    }
    log.warn(`copy "${track.title}" ${track.key} failed (${kind}: ${reason}); trying another copy of "${entry.asked}"`);
    if (cur.source) cur.source.destroy();
    this._play(entry, cur.gen);
  }

  _ended(cur, { positionMs, early, reason, kind }) {
    const { entry, track } = cur;
    const played = positionMs / 1000;
    const dur = Number(cur.probe?.duration) || Number(track.duration) || 0;
    log.info(`stream end "${track.title}" ${track.key} played=${Math.round(played)}s of ${Math.round(dur)}s early=${early} ${kind ? `${kind}: ${reason}` : ''} volume=${this.volume}`);

    // A preview or broken file. Not "the song finished".
    if (played < config.minSongSec && (!dur || played < dur - 10)) {
      entry.tried.add(track.key);
      if (!entry.firstReason) entry.firstReason = `the copy I found stopped after ${Math.round(played)} seconds`;
      if (entry.copies >= MAX_COPIES_PER_REQUEST) {
        this._fail(cur, entry.firstReason, 'preview');
        return;
      }
      log.warn(`"${track.title}" ${track.key} stopped after ${Math.round(played)}s of ${Math.round(dur)}s: bad copy, finding a full one for "${entry.asked}"`);
      this._play(entry, cur.gen);
      return;
    }
    // Cut off mid-song (network). Continue the same copy from where it stopped.
    if (dur && played < dur - 15 && cur.resumeTries < 2) {
      log.warn(`"${track.title}" cut off at ${Math.round(played)}s of ${Math.round(dur)}s; resuming the same copy`);
      this._play(entry, cur.gen, { startSec: Math.max(0, played - 1), resumeTries: cur.resumeTries + 1, resumeOf: { track, probe: cur.probe } });
      return;
    }
    this._startNext('ended');
  }

  _fail(cur, reason, kind) {
    if (this.current !== cur) return;
    this._recordHistory(cur, 'failed');
    const e = cur.entry;
    log.warn(`cannot play "${e.asked}" (${kind}): ${reason}. tried=${[...(e.tried || [])].join(',') || 'none'}`);
    this.emit('trackFailed', { ...e, title: e.asked || e.title }, reason, kind);
    this._startNext('failed');
  }

  /** Resolve the next entry while this one plays, so the next start is instant and dead songs fail early. */
  _prefetch() {
    const next = this.queue.items[0];
    if (!next || next.resolved || next.prefetching || next.cancelled) return;
    // Only a cancel aborts. Moving from the queue to "now playing" mid-probe is normal; _play awaits this.
    const aborted = () => next.cancelled;
    next.prefetching = findPlayable(next, { blocked: (t) => this._candidateBlocked(next, t), aborted })
      .then((res) => {
        if (res.ok) next.resolved = res;
        else if (res.kind !== 'aborted') {
          next.firstReason = next.firstReason || res.reason;
          log.info(`prefetch: no playable copy yet for "${next.asked}" (${res.reason})`);
        }
      })
      .catch((e) => log.warn(`prefetch failed: ${e.message}`))
      .finally(() => {
        next.prefetching = null;
      });
  }

  _recordHistory(cur, how) {
    if (cur.recorded) return;
    cur.recorded = true;
    const e = cur.entry;
    const t = cur.track || e;
    store.addHistory(this.guildId, {
      id: t.key && !String(t.key).startsWith('ask:') ? t.key : null,
      key: songKey(t.title || e.asked),
      title: t.title || e.asked,
      channel: t.channel || '',
      asked: e.asked,
      via: e.via,
      how,
    });
  }

  _watch() {
    const cur = this.current;
    if (!cur?.source || cur.status !== 'playing') return;
    if (cur.source.checkStall(!this.paused)) {
      const pos = cur.source.positionMs;
      log.warn(`"${cur.track.title}" stalled at ${Math.round(pos / 1000)}s`);
      cur.source.destroy();
      this._ended(cur, { positionMs: pos, early: true, reason: 'the stream stalled', kind: 'timeout' });
    }
  }

  _queueBrief() {
    return this.queue.items.slice(0, 6).map((e) => `${e.via}:${e.asked}`).join(' | ') || 'empty';
  }

  destroy() {
    clearInterval(this.watchdog);
    this.gen++;
    if (this.current) this.current.entry.cancelled = true;
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
  const title = e.title && e.title !== e.asked && !String(e.key || '').startsWith('ask:') ? e.title : e.asked || e.title;
  return `${title}${e.channel ? ` - ${e.channel}` : ''} (${fmtTime(e.duration)}, ${who})`;
}

module.exports = { MusicPlayer, fmtTime, fmtEntry };
