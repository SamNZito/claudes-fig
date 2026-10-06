'use strict';
// Short-term memory for one guild: what was said in the call recently, Fig's recent exchanges,
// and an image Fig is "holding" (a screenshot someone showed it). "Forget" wipes all of it.
const HOLD_IMAGE_MS = 3 * 60 * 1000;

class Memory {
  constructor() {
    this.transcript = []; // { at, userId, name, text, fig:boolean }
    this.exchanges = []; // chat messages for Grok: { role, content }
    this.image = null; // { dataUrl, from, at, note }
  }

  hear(userId, name, text) {
    this.transcript.push({ at: Date.now(), userId, name, text, fig: false });
    if (this.transcript.length > 60) this.transcript.shift();
  }

  figSaid(text, toName) {
    this.transcript.push({ at: Date.now(), userId: 'fig', name: 'Fig', text: toName ? `(to ${toName}) ${text}` : text, fig: true });
    if (this.transcript.length > 60) this.transcript.shift();
  }

  addExchange(userMsg, assistantMsg) {
    this.exchanges.push({ role: 'user', content: userMsg }, { role: 'assistant', content: assistantMsg || '(did it)' });
    if (this.exchanges.length > 16) this.exchanges.splice(0, this.exchanges.length - 16);
  }

  recentTranscript(n = 14, maxAgeMs = 10 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    return this.transcript.filter((l) => l.at >= cutoff).slice(-n);
  }

  holdImage(dataUrl, from, note = '') {
    this.image = { dataUrl, from, at: Date.now(), note };
  }

  heldImage() {
    if (this.image && Date.now() - this.image.at > HOLD_IMAGE_MS) this.image = null;
    return this.image;
  }

  dropImage() {
    const had = Boolean(this.image);
    this.image = null;
    return had;
  }

  forget() {
    this.exchanges = [];
    this.image = null;
    this.transcript = [];
  }
}

module.exports = { Memory };
