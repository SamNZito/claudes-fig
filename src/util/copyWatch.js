'use strict';
// Is another program running on this bot token? Every way Fig can tell ends up here, so the log, the
// chat warning and the web page all agree.
//
// Signals:
//   voice    our bot user is in voice under a gateway session that isn't ours (src/discord/instanceGuard.js)
//   command  a slash command was already answered when this copy tried to answer it (Discord error 40060)
//   message  a message from our own bot user appeared that this copy never sent
//
// The message signal works across machines and needs nothing from the other copy: every copy sees every
// message the bot posts, so whichever copy did NOT post a "Now playing" line knows another one did.
const { EventEmitter } = require('node:events');
const log = require('../log').logger('copies');

const GRACE_MS = Number(process.env.FIG_COPY_GRACE_MS || 8000);

class CopyWatch extends EventEmitter {
  constructor() {
    super();
    this.sent = new Map(); // message id -> time, for messages this copy posted
    this.interactions = new Map(); // interaction id -> time, for commands this copy handled
    this.pendingSends = 0;
    this.signals = { voice: 0, command: 0, message: 0 };
    this.recent = []; // last 50 { at, kind, detail }
  }

  /** Wrap a send so the resulting message is known to be ours. */
  track(promise) {
    this.pendingSends++;
    return Promise.resolve(promise).then(
      (m) => {
        this.pendingSends--;
        if (m && m.id) this.noteSent(m.id);
        return m;
      },
      (e) => {
        this.pendingSends--;
        throw e;
      },
    );
  }

  noteSent(id) {
    this.sent.set(String(id), Date.now());
    this.prune(this.sent);
  }

  noteInteraction(id) {
    this.interactions.set(String(id), Date.now());
    this.prune(this.interactions);
  }

  prune(map) {
    if (map.size < 2000) return;
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const [k, t] of map) if (t < cutoff) map.delete(k);
  }

  /**
   * A message from our own bot user arrived on the gateway. Decide (after a short grace period, since
   * the gateway can deliver it before our own send call returns) whether this copy posted it.
   * @returns {Promise<boolean>} true if another copy posted it
   */
  async checkOwnMessage(message, { graceMs = GRACE_MS } = {}) {
    const meta = message.interactionMetadata || message.interaction;
    if (meta?.id) {
      // A reply to a slash command. Ours if this copy handled that command.
      await sleep(Math.min(graceMs, 3000));
      if (this.interactions.has(String(meta.id))) return false;
      this.report('message', `a reply to /${meta.commandName || meta.name || '?'} came from another copy`, { channel: message.channel?.name });
      return true;
    }
    const until = Date.now() + graceMs * 4;
    await sleep(graceMs);
    while (!this.sent.has(String(message.id)) && this.pendingSends > 0 && Date.now() < until) await sleep(1000);
    if (this.sent.has(String(message.id))) return false;
    this.report('message', `posted "${String(message.content || '').slice(0, 120)}" and this copy did not`, { channel: message.channel?.name });
    return true;
  }

  report(kind, detail, { channel } = {}) {
    this.signals[kind] = (this.signals[kind] || 0) + 1;
    const entry = { at: new Date().toISOString(), kind, detail: `${detail}${channel ? ` (#${channel})` : ''}` };
    this.recent.push(entry);
    if (this.recent.length > 50) this.recent.shift();
    log.error(`ANOTHER COPY (${kind}): ${entry.detail}`);
    try {
      require('../crashlog').note(`ANOTHER COPY (${kind}): ${entry.detail}`);
    } catch {
      /* ignore */
    }
    this.emit('copy', entry);
    return entry;
  }

  /** Tell the room, at most once per 10 minutes per server. Says which copy is talking. */
  warnInChat(session, entry) {
    if (!session?.postText) return;
    const id = session.guild?.id || '?';
    this.lastWarned = this.lastWarned || new Map();
    if (Date.now() - (this.lastWarned.get(id) || 0) < 10 * 60 * 1000) return;
    this.lastWarned.set(id, Date.now());
    const me = require('./instance').describe();
    session.postText(
      `Another copy of Fig is running on this bot token (${entry.detail}). Two copies fight over voice, which is what makes old songs cut in. ` +
        `This is ${me}. Stop the other one; if your host has a Publish/deploy button, the editor's run and the published deployment are two copies.`,
    );
  }

  snapshot() {
    const total = Object.values(this.signals).reduce((a, b) => a + b, 0);
    return { total, signals: { ...this.signals }, recent: this.recent.slice(-20), last: this.recent[this.recent.length - 1] || null };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { copyWatch: new CopyWatch(), CopyWatch };
