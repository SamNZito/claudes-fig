'use strict';
// Fig's own web page: live status and live logs, served by the bot process itself.
//
//   GET /                 the page (status cards + live log with tabs and search)
//   GET /api/status       JSON: which copy this is, gateway, every server's voice/music state, other-copy signals
//   GET /api/logs         JSON: last lines of a log.  ?file=fig|conversation|crash  &view=all|talk|music|onair|problems|copies
//                         &q=<text to search>  &lines=<max, default 400>
//   GET /api/stream       Server-sent events: every new fig.log line as it is written
//
// Logs hold what people said, so by default this listens on 127.0.0.1 only. To expose it (for example
// so the hosted page can show it), set FIG_WEB_HOST=0.0.0.0 AND FIG_WEB_KEY=<secret>; then every request
// needs ?key=<secret> or the header x-fig-key. Without a key, Fig refuses to listen beyond this machine.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const log = require('../log').logger('web');
const { ACTIVITY, CONVERSATION } = require('../log');

const FILES = {
  fig: ACTIVITY,
  conversation: CONVERSATION,
  crash: path.join(path.dirname(ACTIVITY), 'crash.log'),
};

const MUSIC_SCOPES = /\[(music|player|resolve|track|spotify|dj|lookup|search|sources|mixer)\]|mixer music ->|on air:/;
const VIEWS = {
  all: () => true,
  talk: (l) => l.includes('[talk]') || /^\S+ \S+ (HEARD|TYPED|SLASH|SAID|POSTED|REPLY|UNSENT) /.test(l),
  music: (l) => MUSIC_SCOPES.test(l),
  onair: (l) => l.includes('on air:') || l.includes('mixer music ->'),
  problems: (l) => / (WARN|ERROR) /.test(l) || l.includes('BUG:'),
  copies: (l) => /ANOTHER COPY|STANDBY|FOREIGN|gateway READY|process started|\[supervise\]|\[instance\]|\[copies\]|BUG:/.test(l),
};

/** Last `max` lines of a file that pass `keep`, reading at most the last 8 MB. */
function tail(file, { max = 400, keep = () => true } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const out = [];
    const CHUNK = 256 * 1024;
    let end = size;
    let carry = '';
    while (end > 0 && out.length < max && size - end < 8 * 1024 * 1024) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString('utf8') + carry;
      const lines = text.split('\n');
      carry = start > 0 ? lines.shift() : '';
      for (let i = lines.length - 1; i >= 0 && out.length < max; i--) if (lines[i] && keep(lines[i])) out.push(lines[i]);
      end = start;
    }
    if (carry && out.length < max && keep(carry)) out.push(carry);
    return { lines: out.reverse(), size };
  } catch {
    return { lines: [], size: 0 };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function filterFor(view, q) {
  const v = VIEWS[view] || VIEWS.all;
  const needle = String(q || '').toLowerCase();
  return (l) => v(l) && (!needle || l.toLowerCase().includes(needle));
}

function startWebServer({ getStatus, port = Number(process.env.FIG_WEB_PORT ?? 8790), host = process.env.FIG_WEB_HOST || '127.0.0.1', key = process.env.FIG_WEB_KEY || '' } = {}) {
  if (String(process.env.FIG_WEB || '').toLowerCase() === 'off') return null;
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!local && !key) {
    log.error(`not serving the log page on ${host}: set FIG_WEB_KEY first (logs contain what people said)`);
    return null;
  }
  const page = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (key && url.searchParams.get('key') !== key && req.headers['x-fig-key'] !== key) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      return res.end('Add ?key=<FIG_WEB_KEY> to the address.');
    }
    const json = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(page);
      }
      if (url.pathname === '/api/status') return json(getStatus ? getStatus() : {});
      if (url.pathname === '/api/logs') {
        const file = FILES[url.searchParams.get('file')] || FILES.fig;
        const max = Math.max(1, Math.min(5000, Number(url.searchParams.get('lines')) || 400));
        const { lines, size } = tail(file, { max, keep: filterFor(url.searchParams.get('view'), url.searchParams.get('q')) });
        return json({ file: path.basename(file), size, lines });
      }
      if (url.pathname === '/api/stream') return stream(req, res);
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      log.warn(`web ${url.pathname} failed: ${e.message}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('error');
    }
  });

  // New fig.log lines, pushed as they are written. Handles rotation (the file getting smaller).
  function stream(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    let offset = 0;
    try {
      offset = fs.statSync(FILES.fig).size;
    } catch {
      /* not written yet */
    }
    let carry = '';
    const timer = setInterval(() => {
      let size = 0;
      try {
        size = fs.statSync(FILES.fig).size;
      } catch {
        return;
      }
      if (size < offset) offset = 0; // rotated
      if (size === offset) return res.write(': ping\n\n');
      const len = Math.min(size - offset, 1024 * 1024);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(FILES.fig, 'r');
      try {
        fs.readSync(fd, buf, 0, len, offset);
      } finally {
        fs.closeSync(fd);
      }
      offset += len;
      const lines = (carry + buf.toString('utf8')).split('\n');
      carry = lines.pop();
      for (const l of lines) if (l) res.write(`data: ${JSON.stringify(l)}\n\n`);
    }, 1000);
    req.on('close', () => clearInterval(timer));
  }

  server.on('error', (e) => log.warn(`log page could not listen on ${host}:${port}: ${e.message}`));
  server.listen(port, host, () => {
    const a = server.address();
    log.info(`log page at http://${host === '0.0.0.0' ? '<this machine>' : host}:${a.port}/${key ? ' (needs ?key=)' : ''}`);
  });
  server.unref();
  return server;
}

module.exports = { startWebServer, tail, filterFor, VIEWS };
