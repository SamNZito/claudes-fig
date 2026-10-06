'use strict';
// Wake-name detection on transcripts. "hey fig play x", "fig, skip", "skip this fig" all count.
// We are strict on purpose: other people's conversation is not a command.

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
 * @returns {{named:boolean, text:string}} text is the transcript with the wake phrase removed
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
      while (before.length && /^(hey|hi|yo|ok|okay|oi|ay|aye|hello|um|uh|so)$/.test(before[before.length - 1])) before.pop();
      const rest = [...before, ...words.slice(i + len)].join(' ').trim();
      return { named: true, text: rest };
    }
  }
  return { named: false, text: t };
}

module.exports = { detectWake, norm, lev, variants };
