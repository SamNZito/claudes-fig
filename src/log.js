'use strict';
// Everything Fig does goes to logs/fig.log: what people said, what Fig said and posted, every slash
// command, every Grok call, every music and voice event, which copy of Fig wrote the line.
// What was said (heard / spoken / posted / typed) also goes to logs/conversation.log on its own.
//
// Lines are written with appendFileSync on purpose: stdout is block-buffered when Fig is not on a
// terminal, so a crash used to take the last minutes of log with it. Do not change this to console only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = () => LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 20;
const DIR = path.join(__dirname, '..', 'logs');
const ACTIVITY = process.env.FIG_LOG || path.join(DIR, 'fig.log');
const CONVERSATION = process.env.FIG_CONVERSATION_LOG || path.join(path.dirname(ACTIVITY), 'conversation.log');
const MAX_BYTES = Number(process.env.FIG_LOG_MAX_MB || 50) * 1024 * 1024;
const KEEP = Number(process.env.FIG_LOG_KEEP || 5); // fig.log.1 .. fig.log.5
// Which copy of Fig wrote the line. Two copies on one token was a real bug; this makes it visible.
const WHO = `${os.hostname().split('.')[0]}:${process.pid}`;

const writes = new Map();

/** Keep each log bounded: fig.log -> fig.log.1 -> ... -> fig.log.N (oldest dropped). */
function rotate(file) {
  try {
    if (fs.statSync(file).size <= MAX_BYTES) return;
    for (let i = KEEP - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      } catch {
        /* missing */
      }
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* ignore */
  }
}

function show(v) {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  try {
    const s = JSON.stringify(v);
    return s.length > 4000 ? `${s.slice(0, 4000)}…(+${s.length - 4000})` : s;
  } catch {
    return String(v);
  }
}

function append(file, line) {
  const n = (writes.get(file) || 0) + 1;
  writes.set(file, n);
  if (n % 500 === 1) rotate(file);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line);
  } catch (e) {
    try {
      fs.appendFileSync(path.join(DIR, 'crash.log'), `${new Date().toISOString()} log write to ${file} failed: ${e.message}\n`);
    } catch {
      /* ignore */
    }
  }
}

function write(level, scope, args) {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${WHO} [${scope}] ${args.map(show).join(' ')}\n`;
  if (process.stdout.isTTY) process.stdout.write(line);
  append(ACTIVITY, line);
}

function logger(scope) {
  return {
    debug: (...a) => current() <= 10 && write('debug', scope, a),
    info: (...a) => current() <= 20 && write('info', scope, a),
    warn: (...a) => current() <= 30 && write('warn', scope, a),
    error: (...a) => write('error', scope, a),
  };
}

/**
 * Something was said or shown. kind: heard | said | posted | typed | slash | reply.
 * Always logged (any LOG_LEVEL), to fig.log and conversation.log.
 */
function conversation(kind, who, text, extra = '') {
  const body = `${kind.toUpperCase().padEnd(6)} ${who ? `${who}: ` : ''}${String(text ?? '').replace(/\s+/g, ' ').trim()}${extra ? `  (${extra})` : ''}`;
  write('info', 'talk', [body]);
  append(CONVERSATION, `${new Date().toISOString()} ${WHO} ${body}\n`);
}

/**
 * Wrap every function on an object so each call is logged: name, caller info, arguments, result,
 * how long it took, and any error. Used for src/actions.js (everything Fig can do).
 */
function traceAll(obj, scope, { describeArgs = (a) => a, describeResult = (r) => r } = {}) {
  const log = logger(scope);
  const out = {};
  for (const [name, fn] of Object.entries(obj)) {
    if (typeof fn !== 'function') {
      out[name] = fn;
      continue;
    }
    out[name] = function traced(...args) {
      const t0 = Date.now();
      let res;
      try {
        res = fn.apply(this, args);
      } catch (e) {
        log.error(`${name}(${show(describeArgs(args))}) threw after ${Date.now() - t0}ms:`, e);
        throw e;
      }
      if (res && typeof res.then === 'function') {
        return res.then(
          (v) => {
            log.info(`${name}(${show(describeArgs(args))}) -> ${show(describeResult(v))} [${Date.now() - t0}ms]`);
            return v;
          },
          (e) => {
            log.error(`${name}(${show(describeArgs(args))}) failed after ${Date.now() - t0}ms:`, e);
            throw e;
          },
        );
      }
      log.info(`${name}(${show(describeArgs(args))}) -> ${show(describeResult(res))} [${Date.now() - t0}ms]`);
      return res;
    };
  }
  return out;
}

module.exports = { logger, conversation, traceAll, show, WHO, ACTIVITY, CONVERSATION };
