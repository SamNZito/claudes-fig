'use strict';
// Why Fig died. Written with appendFileSync so a kill still leaves the last lines on disk.
// Activity stays in /tmp/claudes-fig.log. This file is only starts, drops, and crashes.
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'logs');
const FILE = path.join(DIR, 'crash.log');
const BEAT = path.join(DIR, 'heartbeat');

function write(msg) {
  const line = `${new Date().toISOString()} pid=${process.pid} ${msg}\n`;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FILE, line);
  } catch {
    /* the crash log must never take the bot down */
  }
}

function note(msg) {
  write(msg);
}

function beat() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(BEAT, `${Date.now()} ${process.pid}\n`);
  } catch {
    /* ignore */
  }
}

/** Call once at startup, before login. */
function noteIfPreviousDied() {
  let raw = '';
  try {
    raw = fs.readFileSync(BEAT, 'utf8');
  } catch {
    write('start. no previous heartbeat (first run, or the logs directory was new).');
    beat();
    return;
  }
  const last = Number(String(raw).split(/\s+/)[0]);
  const prevPid = String(raw).split(/\s+/)[1] || '?';
  if (!last) return;
  const ageSec = Math.round((Date.now() - last) / 1000);
  if (ageSec > 20) {
    write(
      `previous process (pid ${prevPid}) disappeared without a shutdown line. ` +
        `last heartbeat ${ageSec}s ago. That is a kill or a machine restart, not a Discord error we got to log.`,
    );
  }
  beat();
}

module.exports = { note, beat, noteIfPreviousDied, FILE };
