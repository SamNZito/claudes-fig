'use strict';
const fs = require('node:fs');
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = () => LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 20;
const ACTIVITY = process.env.FIG_LOG || require('node:path').join(__dirname, '..', 'logs', 'fig.log');

function fmt(level, scope, args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return [`${ts} ${level.toUpperCase().padEnd(5)} [${scope}]`, ...args];
}

function flush(parts) {
  // stdout is block-buffered when Fig is not attached to a terminal, so a crash
  // used to take the last minutes of log with it. Write the line to disk now.
  const line = `${parts.join(' ')}\n`;
  try {
    fs.mkdirSync(require('node:path').dirname(ACTIVITY), { recursive: true });
    fs.appendFileSync(ACTIVITY, line);
  } catch (e) {
    try {
      fs.appendFileSync(require('node:path').join(__dirname, '..', 'logs', 'crash.log'), `${new Date().toISOString()} activity log write failed: ${e.message}\n`);
    } catch {
      /* ignore */
    }
  }
}

function logger(scope) {
  return {
    debug: (...a) => current() <= 10 && flush(fmt('debug', scope, a)),
    info: (...a) => current() <= 20 && flush(fmt('info', scope, a)),
    warn: (...a) => current() <= 30 && flush(fmt('warn', scope, a)),
    error: (...a) => flush(fmt('error', scope, a)),
  };
}

module.exports = { logger };
