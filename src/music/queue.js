'use strict';
// Upcoming songs. Each entry gets its own uid, so the same track queued twice is two entries,
// and two uploads with the same title are always two different entries.
let nextUid = 1;

class Queue {
  constructor() {
    this.items = [];
  }

  static entry(track, { requestedBy = null, via = 'user' } = {}) {
    return { ...track, uid: nextUid++, requestedBy, via, addedAt: Date.now() };
  }

  get length() {
    return this.items.length;
  }

  add(entries, { front = false } = {}) {
    if (front) this.items.unshift(...entries);
    else this.items.push(...entries);
  }

  shift() {
    return this.items.shift() || null;
  }

  /** Remove by 1-based position. */
  removeAt(position) {
    const i = position - 1;
    if (i < 0 || i >= this.items.length) return null;
    return this.items.splice(i, 1)[0];
  }

  /** Remove the first upcoming entry whose title matches words in the query. */
  removeMatching(query) {
    const words = String(query)
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 1);
    if (!words.length) return null;
    let best = -1;
    let bestScore = 0;
    this.items.forEach((e, i) => {
      const hay = `${e.title} ${e.channel}`.toLowerCase();
      const score = words.filter((w) => hay.includes(w)).length / words.length;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best < 0 || bestScore < 0.5) return null;
    return this.items.splice(best, 1)[0];
  }

  removeWhere(pred) {
    const before = this.items.length;
    this.items = this.items.filter((e) => !pred(e));
    return before - this.items.length;
  }

  clear() {
    const n = this.items.length;
    this.items = [];
    return n;
  }

  shuffle() {
    for (let i = this.items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
    }
  }

  count(pred) {
    return this.items.filter(pred).length;
  }

  has(key) {
    return this.items.some((e) => e.key === key);
  }
}

module.exports = { Queue };
