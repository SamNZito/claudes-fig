'use strict';
// The log page Fig serves: status JSON, filtered log tails, the live stream, and the key check.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { logger, ACTIVITY } = require('../src/log');
const { startWebServer, tail, filterFor } = require('../src/web/server');

const listening = (srv) => new Promise((r) => (srv.listening ? r() : srv.once('listening', r)));
const base = (srv) => `http://127.0.0.1:${srv.address().port}`;

test('status, log views and search', async () => {
  const music = logger('music');
  music.info('on air: "Christmas [soundcloud:1] from 0s" sent 45s, voice=ready');
  logger('copies').error('ANOTHER COPY (message): posted "Now playing: Let Go" and this copy did not');
  logger('talk').info('HEARD  Alice: fig play let go');
  const srv = startWebServer({ port: 0, getStatus: () => ({ copy: { pid: 1 }, servers: [] }) });
  await listening(srv);
  try {
    const st = await (await fetch(`${base(srv)}/api/status`)).json();
    assert.equal(st.copy.pid, 1);
    const onair = await (await fetch(`${base(srv)}/api/logs?view=onair`)).json();
    assert.ok(onair.lines.some((l) => l.includes('on air: "Christmas')));
    assert.ok(onair.lines.every((l) => l.includes('on air:') || l.includes('mixer music ->')));
    const copies = await (await fetch(`${base(srv)}/api/logs?view=copies`)).json();
    assert.ok(copies.lines.some((l) => l.includes('ANOTHER COPY (message)')));
    const talk = await (await fetch(`${base(srv)}/api/logs?view=talk&q=let%20go`)).json();
    assert.ok(talk.lines.some((l) => l.includes('HEARD  Alice: fig play let go')));
    const html = await (await fetch(`${base(srv)}/`)).text();
    assert.match(html, /<title>Fig live log<\/title>/);
  } finally {
    srv.close();
  }
});

test('the live stream sends new lines as they are written', async () => {
  const srv = startWebServer({ port: 0 });
  await listening(srv);
  const ac = new AbortController();
  try {
    const res = await fetch(`${base(srv)}/api/stream`, { signal: ac.signal });
    const reader = res.body.getReader();
    setTimeout(() => logger('music').info('stream-test-line 123'), 300);
    let got = '';
    const until = Date.now() + 5000;
    while (!got.includes('stream-test-line 123') && Date.now() < until) {
      const { value, done } = await reader.read();
      if (done) break;
      got += Buffer.from(value).toString('utf8');
    }
    assert.match(got, /data: ".*stream-test-line 123/);
  } finally {
    ac.abort();
    srv.close();
  }
});

test('a key is required when one is set, and Fig will not listen publicly without one', async () => {
  const srv = startWebServer({ port: 0, key: 's3cret' });
  await listening(srv);
  try {
    assert.equal((await fetch(`${base(srv)}/api/status`)).status, 401);
    assert.equal((await fetch(`${base(srv)}/api/status?key=s3cret`)).status, 200);
  } finally {
    srv.close();
  }
  assert.equal(startWebServer({ port: 0, host: '0.0.0.0', key: '' }), null);
});

test('tail reads the end of a big file and keeps whole lines', () => {
  const f = `${ACTIVITY}.tailtest`;
  fs.writeFileSync(f, Array.from({ length: 50000 }, (_, i) => `line ${i} ${i % 7 === 0 ? 'on air:' : 'x'}`).join('\n') + '\n');
  try {
    const { lines } = tail(f, { max: 10, keep: filterFor('onair') });
    assert.equal(lines.length, 10);
    assert.equal(lines[9], 'line 49999 x'.replace('49999 x', '49994 on air:'));
    assert.ok(lines.every((l) => /^line \d+ on air:$/.test(l)));
  } finally {
    fs.unlinkSync(f);
  }
});

test('each server reports what is on air, the request and the queue', () => {
  const { fakeGuild } = require('./helpers');
  const { GuildSession } = require('../src/voice/session');
  const s = new GuildSession({}, fakeGuild('web-status'));
  let st = s.statusSnapshot();
  assert.equal(st.voice, 'not connected');
  assert.equal(st.onAir, null);
  assert.deepEqual(st.queue, []);
  s.mixer.setMusic({ label: 'Let Go [soundcloud:1] from 0s', hasData: true, startedEmitted: true, finished: false, read: (n) => Buffer.alloc(n), destroy() {}, once() {} });
  for (let i = 0; i < 100; i++) s.mixer.nextFrame();
  st = s.statusSnapshot();
  assert.equal(st.onAir.label, 'Let Go [soundcloud:1] from 0s');
  assert.equal(st.onAir.sentSec, 2);
  assert.equal(st.mode, 'normal');
  s.destroy();
});
