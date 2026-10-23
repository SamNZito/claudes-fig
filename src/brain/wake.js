'use strict';
// Wake-name detection on transcripts. "hey fig play x", "fig, skip", "skip this fig" all count.
// We are strict on purpose: other people's conversation is not a command.

const GREETING = /^(hey|hi|yo|ok|okay|oi|ay|aye|hello|um|uh|so)$/;

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// Common mis-hearings of short names. Extend per name if needed.
const ALIASES = {
  fig: ['fig', 'figg', "fig's", 'phig', 'fyg'],
};

/** Words the name is allowed to be heard as. */
function variants(name) {
  const n = norm(name);
  const set = new Set([n, `${n}'s`, ...(ALIASES[n] || [])]);
  return [...set];
}

/**
 * The consonant "shape" of a word, ignoring vowels: fig, fake, fix, fick, feg -> "FK".
 * Similar-sounding consonants share a letter (f/v/ph, k/g/c/q/x, s/z, t/d, p/b, ...).
 * Used to notice when the speech-to-text probably misheard the name.
 */
function skeleton(word) {
  let w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  w = w.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/qu/g, 'k');
  const CLASS = { b: 'P', p: 'P', f: 'F', v: 'F', g: 'K', k: 'K', c: 'K', q: 'K', x: 'K', j: 'J', s: 'S', z: 'S', t: 'T', d: 'T', m: 'M', n: 'N', l: 'L', r: 'R' };
  let out = '';
  for (const ch of w) {
    const c = CLASS[ch];
    if (c && out[out.length - 1] !== c) out += c;
  }
  return out;
}

/** Does this one word sound like the (one-word) name? "fake", "fix", "figs" sound like "fig". */
function soundsLikeName(word, name) {
  const n = norm(name);
  const w = norm(word).replace(/'s$/, '');
  if (!w || !n || n.includes(' ') || w === n) return false;
  if (w.length > n.length + 3) return false;
  const a = skeleton(w);
  const b = skeleton(n);
  return Boolean(b) && (a === b || a === `${b}S`);
}

/**
 * @returns {{named:boolean, text:string, heardAs?:string, nearMiss?:{word:string, index:number}|null}}
 *   text is the transcript with the wake phrase removed. nearMiss: when the name wasn't heard, a word
 *   that sounds like it (e.g. "fake" for "fig"), so simple commands still work (nearMissRest).
 */
function detectWake(transcript, name) {
  const t = norm(transcript);
  if (!t) return { named: false, text: '' };
  const nameNorm = norm(name);
  const nameWords = nameNorm.split(' ');
  const words = t.split(' ');
  const vs = variants(name);
  const len = nameWords.length;
  for (let i = 0; i + len <= words.length; i++) {
    const chunk = words.slice(i, i + len).join(' ');
    let hit = vs.includes(chunk);
    // Fuzzy for longer names only (short names like "fig" would match "big", "fix"...)
    if (!hit && nameNorm.length >= 5) hit = lev(chunk, nameNorm) <= 1;
    if (hit) {
      const before = words.slice(0, i);
      // drop a greeting right before the name: "hey fig", "yo fig", "ok fig"
      while (before.length && GREETING.test(before[before.length - 1])) before.pop();
      const rest = [...before, ...words.slice(i + len)].join(' ').trim();
      return { named: true, text: rest, heardAs: chunk };
    }
  }
  const idx = len === 1 ? words.findIndex((w) => soundsLikeName(w, name)) : -1;
  return { named: false, text: t, nearMiss: idx >= 0 ? { word: words[idx], index: idx } : null };
}

// Words worth hinting to speech-to-text: the name (with the usual greetings) and the short spoken
// commands, which are the words most often misheard ("skip" as "kip"). Kept short on purpose: every
// hint pulls unclear audio toward it. Extra hints: STT_KEYTERMS=word,another phrase
const COMMAND_TERMS = ['skip', 'pause', 'resume', 'unpause', 'stop', 'queue', 'shuffle', 'volume', 'louder', 'quieter', 'DJ'];

function sttKeyterms(name, extra = []) {
  const n = String(name || '').trim();
  const cap = n ? n[0].toUpperCase() + n.slice(1) : '';
  return [...(cap ? [cap, `Hey ${cap}`, `Okay ${cap}`] : []), ...COMMAND_TERMS, ...extra];
}

/**
 * "Hey, fake skip" -> "skip". When the name wasn't heard but a sound-alike word starts the sentence
 * (optionally after a greeting), returns the words after it, so the caller can accept them only if
 * they are a simple command. Anything else returns null.
 */
function nearMissRest(transcript, name) {
  const w = detectWake(transcript, name);
  if (w.named || !w.nearMiss) return null;
  const words = norm(transcript).split(' ');
  const before = words.slice(0, w.nearMiss.index);
  if (!before.every((x) => GREETING.test(x))) return null;
  return { word: w.nearMiss.word, rest: words.slice(w.nearMiss.index + 1).join(' ') };
}

module.exports = { nearMissRest, GREETING, detectWake, norm, lev, variants, sttKeyterms, COMMAND_TERMS, skeleton, soundsLikeName };
