'use strict';
// Who is this copy of Fig? Shown in /status and in the logs, so two copies on one token are easy to spot.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const startedAt = Date.now();

function gitSha() {
  try {
    const head = fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head.slice(0, 7);
    const ref = head.slice(5).trim();
    try {
      return fs.readFileSync(path.join(ROOT, '.git', ref), 'utf8').trim().slice(0, 7);
    } catch {
      const packed = fs.readFileSync(path.join(ROOT, '.git', 'packed-refs'), 'utf8');
      const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
      return line ? line.slice(0, 7) : 'unknown';
    }
  } catch {
    return 'no-git';
  }
}

const sha = gitSha();

function describe() {
  return `${os.hostname()} pid ${process.pid} code ${sha} in ${ROOT}`;
}

function uptime() {
  const m = Math.round((Date.now() - startedAt) / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

module.exports = { describe, uptime, sha, ROOT };
