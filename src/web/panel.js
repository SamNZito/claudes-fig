'use strict';
// Fig's control panel: the one page you keep open on the host.
//
//   - Paste a new bot token -> it is saved to data/discord-token (owner-only file) and Fig (re)starts.
//   - Token already saved -> just press Start. Stop and Restart too.
//   - Shows how many supervisors / bots / strays are running on this machine, the heartbeat, and
//     Fig's live log page (src/web/server.js) underneath, proxied at /fig/.
//
// It runs as its own small process (npm run panel), separate from Fig, so it stays up while Fig is
// stopped or restarting. Start launches scripts/supervise.js detached, exactly like
// scripts/ensure-running.sh does. Stop leaves data/fig.stopped so the every-minute ensure-running
// check doesn't bring Fig straight back; Start removes it.
//
// Security: this page can start and stop the bot and shows what people said. On anything but
// 127.0.0.1 it needs FIG_PANEL_KEY (asked once, then remembered in an HttpOnly cookie).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const log = require('../log').logger('panel');

const TOKEN_RE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/;

function createPanel({
  root = path.join(__dirname, '..', '..'),
  logsDir = process.env.FIG_LOGS_DIR || path.join(root, 'logs'),
  dataDir = process.env.FIG_PANEL_DATA || path.join(root, 'data'),
  tokenFile = process.env.FIG_TOKEN_FILE || path.join(dataDir, 'discord-token'),
  supervise = path.join(root, 'scripts', 'supervise.js'),
  figPort = Number(process.env.FIG_WEB_PORT || 8790),
  figKey = process.env.FIG_WEB_KEY || '',
  key = process.env.FIG_PANEL_KEY || '',
  childEnv = {},
} = {}) {
  const files = {
    supPid: path.join(logsDir, 'supervisor.pid'),
    figPid: path.join(logsDir, 'fig.pid'),
    beat: path.join(logsDir, 'heartbeat'),
    stopped: path.join(dataDir, 'fig.stopped'),
    out: path.join(logsDir, 'supervise.out'),
  };
  const page = fs.readFileSync(path.join(__dirname, 'panel.html'), 'utf8');
  const cookieValue = key ? crypto.createHash('sha256').update(`fig-panel:${key}`).digest('hex') : '';
  let busy = null; // one start/stop at a time

  const readPid = (f) => {
    try {
      const raw = fs.readFileSync(f, 'utf8').trim();
      const n = raw.startsWith('{') ? JSON.parse(raw).pid : Number(raw);
      return Number.isInteger(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  };
  const alive = (pid) => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
    } catch (e) {
      return e.code === 'EPERM';
    }
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.split(') ').pop().trim().startsWith('Z')) return false;
    } catch {
      /* not linux */
    }
    return true;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Fig processes on this machine (Linux): supervisors, bots, and bots with no supervisor parent. */
  function processes() {
    let entries;
    try {
      entries = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
    } catch {
      return null; // not linux: only the pid files are known
    }
    const sups = [];
    const bots = [];
    for (const d of entries) {
      try {
        const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ');
        if (!/\bnode\b|node(\.exe)?\s/.test(cmd) && !cmd.includes(process.execPath)) continue;
        const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        const after = stat.split(') ').pop().trim().split(' ');
        if (after[0] === 'Z') continue;
        const ppid = Number(after[1]);
        if (/scripts[/\\]supervise\.js/.test(cmd)) sups.push(Number(d));
        else if (/src[/\\]index\.js/.test(cmd)) bots.push({ pid: Number(d), ppid });
      } catch {
        /* process went away */
      }
    }
    return { supervisors: sups.length, bots: bots.length, stray: bots.filter((b) => !sups.includes(b.ppid)).length };
  }

  function tokenState() {
    try {
      if (fs.readFileSync(tokenFile, 'utf8').trim()) return 'panel';
    } catch {
      /* none */
    }
    if (process.env.DISCORD_TOKEN) return 'env';
    try {
      const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
      if (/^DISCORD_TOKEN=\S+/m.test(env)) return 'env';
    } catch {
      /* no .env */
    }
    return null;
  }

  function state() {
    const supPid = readPid(files.supPid);
    const figPid = readPid(files.figPid);
    let beatAge = null;
    try {
      beatAge = Math.round((Date.now() - Number(fs.readFileSync(files.beat, 'utf8').split(' ')[0])) / 1000);
    } catch {
      /* never beat */
    }
    const running = alive(supPid);
    return {
      token: tokenState(),
      running,
      busy,
      supervisor: { pid: supPid, alive: running },
      bot: { pid: figPid, alive: alive(figPid), heartbeatSec: beatAge },
      stoppedOnPurpose: fs.existsSync(files.stopped),
      processes: processes(),
      code: require('../util/instance').sha,
    };
  }

  async function start(reason) {
    if (alive(readPid(files.supPid))) return { status: 409, message: 'Fig is already running.' };
    if (!tokenState()) return { status: 400, message: 'Save the bot token first.' };
    fs.rmSync(files.stopped, { force: true });
    fs.mkdirSync(logsDir, { recursive: true });
    const out = fs.openSync(files.out, 'a');
    const child = spawn(process.execPath, [supervise], {
      cwd: root,
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, FIG_PANEL_DATA: dataDir, ...childEnv }, // a token saved here is read from its file (src/config.js), never passed in the environment
    });
    fs.closeSync(out);
    child.unref();
    log.info(`start (${reason}): supervisor pid ${child.pid}`);
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      if (readPid(files.supPid) === child.pid) return { status: 200, message: 'Fig is starting.' };
      if (child.exitCode !== null) break;
    }
    if (alive(child.pid)) return { status: 200, message: 'Fig is starting.' };
    return { status: 500, message: `The supervisor exited right away. Check ${path.relative(root, files.out)} and logs/crash.log.` };
  }

  async function stop(reason, { onPurpose = true } = {}) {
    if (onPurpose) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(files.stopped, `${new Date().toISOString()} ${reason}\n`);
    }
    const sup = readPid(files.supPid);
    const fig = readPid(files.figPid);
    if (!alive(sup) && !alive(fig)) return { status: 200, message: 'Fig was not running.' };
    log.info(`stop (${reason}): supervisor ${sup || '-'} bot ${fig || '-'}`);
    if (alive(sup)) process.kill(sup, 'SIGTERM'); // the supervisor stops the bot and exits
    else if (alive(fig)) process.kill(fig, 'SIGTERM');
    for (let i = 0; i < 100 && (alive(sup) || alive(fig)); i++) await sleep(100);
    for (const p of [sup, fig]) {
      if (alive(p)) {
        log.warn(`pid ${p} did not stop in 10s; killing it`);
        try {
          process.kill(p, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
    await sleep(200);
    return { status: 200, message: 'Fig stopped.' };
  }

  function saveToken(token) {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    const tmp = `${tokenFile}.tmp`;
    fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
    fs.renameSync(tmp, tokenFile);
    try {
      fs.chmodSync(tokenFile, 0o600);
    } catch {
      /* windows */
    }
    log.info('new bot token saved from the panel'); // never the token itself
  }

  const once = (fn) => async (...a) => {
    if (busy) return { status: 409, message: `Busy: ${busy}.` };
    busy = fn.name;
    try {
      return await fn(...a);
    } finally {
      busy = null;
    }
  };
  const actions = {
    start: once(async function starting() {
      return start('Start button');
    }),
    stop: once(async function stopping() {
      return stop('Stop button');
    }),
    restart: once(async function restarting() {
      await stop('Restart button', { onPurpose: false });
      return start('Restart button');
    }),
    token: once(async function savingToken(token) {
      if (!TOKEN_RE.test(token)) return { status: 400, message: "That doesn't look like a Discord bot token." };
      const was = alive(readPid(files.supPid));
      if (was) await stop('new token', { onPurpose: false });
      saveToken(token);
      const r = await start('new token');
      return r.status === 200 ? { status: 200, message: `Token saved. ${was ? 'Fig restarted with it.' : 'Fig is starting.'}` } : r;
    }),
  };

  function authed(req) {
    if (!key) return true;
    const c = String(req.headers.cookie || '')
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('fig_panel='));
    const v = c ? c.slice('fig_panel='.length) : '';
    return v.length === cookieValue.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(cookieValue));
  }

  function body(req, limit = 4096) {
    return new Promise((resolve, reject) => {
      let s = '';
      req.on('data', (d) => {
        s += d;
        if (s.length > limit) {
          reject(new Error('too big'));
          req.destroy();
        }
      });
      req.on('end', () => resolve(s));
      req.on('error', reject);
    });
  }

  function proxyFig(req, res, url) {
    const target = url.pathname.replace(/^\/fig/, '') || '/';
    const qs = new URLSearchParams(url.search);
    qs.delete('key');
    if (figKey) qs.set('key', figKey);
    const q = qs.toString();
    const up = http.request(
      { host: '127.0.0.1', port: figPort, path: `${target}${q ? `?${q}` : ''}`, method: 'GET', headers: { accept: req.headers.accept || '*/*' } },
      (r) => {
        res.writeHead(r.statusCode, { 'content-type': r.headers['content-type'] || 'text/plain', 'cache-control': 'no-store' });
        r.pipe(res);
      },
    );
    up.on('error', () => {
      if (res.headersSent) return res.end();
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<body style="font:15px system-ui;padding:24px;color:#6b665e;background:transparent">Fig isn\'t running, so there is no live log yet. Press Start.</body>',
      );
    });
    req.on('close', () => up.destroy());
    up.end();
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method === 'POST' && url.pathname === '/login') {
        const k = new URLSearchParams(await body(req)).get('key') || '';
        const ok = key && k.length === key.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(key));
        if (!ok) {
          log.warn('panel login with a wrong key');
          res.writeHead(303, { location: './?wrong=1' });
          return res.end();
        }
        res.writeHead(303, { location: './', 'set-cookie': `fig_panel=${cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
        return res.end();
      }
      if (!authed(req)) {
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/fig/')) return send(401, { message: 'Log in first.' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(page.replace('<body>', '<body data-login="1">'));
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(page);
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return send(200, state());
      if (url.pathname.startsWith('/fig/') || url.pathname === '/fig') {
        if (url.pathname === '/fig') {
          res.writeHead(301, { location: 'fig/' });
          return res.end();
        }
        return proxyFig(req, res, url);
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        // Only this page's own script can call these (custom header => no cross-site form posts).
        if (req.headers['x-fig-panel'] !== '1') return send(403, { message: 'Use the panel page.' });
        const name = url.pathname.slice(5);
        if (name === 'token') {
          let token = '';
          try {
            token = String(JSON.parse(await body(req)).token || '').trim();
          } catch {
            return send(400, { message: 'Bad request.' });
          }
          const r = await actions.token(token);
          return send(r.status, { message: r.message, state: state() });
        }
        if (actions[name]) {
          const r = await actions[name]();
          return send(r.status, { message: r.message, state: state() });
        }
      }
      send(404, { message: 'Not found.' });
    } catch (e) {
      log.error(`panel ${req.method} ${url.pathname} failed:`, e);
      if (!res.headersSent) send(500, { message: e.message });
      else res.end();
    }
  });

  return { server, state, actions, files };
}

/** Run the panel (scripts/panel.js). */
function main() {
  const port = Number(process.env.PORT || process.env.FIG_PANEL_PORT || 8080);
  const host = process.env.FIG_PANEL_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
  const key = process.env.FIG_PANEL_KEY || '';
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!local && !key) {
    console.error(`Refusing to serve the control panel on ${host} without FIG_PANEL_KEY: it can start/stop Fig and shows what people said.`);
    log.error(`panel not started: FIG_PANEL_KEY missing for host ${host}`);
    process.exit(1);
  }
  const { server, state } = createPanel({ key });
  server.listen(port, host, () => {
    log.info(`control panel on http://${host}:${port}/${key ? ' (key required)' : ''}`);
    console.log(`Fig control panel: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`);
    const s = state();
    if (s.token && !s.running && !s.stoppedOnPurpose) log.info('a token is saved and Fig is not running: press Start');
  });
}

module.exports = { createPanel, main, TOKEN_RE };
