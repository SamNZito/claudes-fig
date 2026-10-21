'use strict';
// The control panel: save a token once, then Start / Stop / Restart run exactly one supervised Fig.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPanel } = require('../src/web/panel');

const TOKEN = `${'A'.repeat(26)}.${'B'.repeat(6)}.${'C'.repeat(38)}`;

function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fig-panel-'));
  const logsDir = path.join(dir, 'logs');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(logsDir);
  const savedEnv = process.env.DISCORD_TOKEN;
  delete process.env.DISCORD_TOKEN;
  const p = createPanel({
    root: dir,
    logsDir,
    dataDir,
    supervise: path.join(__dirname, '..', 'scripts', 'supervise.js'),
    childEnv: { FIG_LOGS_DIR: logsDir, FIG_ENTRY: path.join(__dirname, 'fixtures', 'panel-fake-fig.js') },
    figPort: 1, // nothing listens there
    ...opts,
  });
  const listening = new Promise((r) => p.server.listen(0, '127.0.0.1', r));
  const restore = () => {
    if (savedEnv !== undefined) process.env.DISCORD_TOKEN = savedEnv;
  };
  return { ...p, dir, logsDir, dataDir, listening, restore, url: () => `http://127.0.0.1:${p.server.address().port}` };
}

const post = (url, name, body) =>
  fetch(`${url}/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fig-panel': '1' }, body: JSON.stringify(body || {}) });

test('start needs a saved token; saving one starts Fig; start again is refused; stop stays stopped', async () => {
  const p = setup();
  await p.listening;
  try {
    let s = await (await fetch(`${p.url()}/api/state`)).json();
    assert.equal(s.token, null);
    assert.equal(s.running, false);

    let r = await post(p.url(), 'start');
    assert.equal(r.status, 400);
    assert.match((await r.json()).message, /Save the bot token first/);

    r = await post(p.url(), 'token', { token: 'not a token' });
    assert.equal(r.status, 400);

    r = await post(p.url(), 'token', { token: TOKEN });
    const d = await r.json();
    assert.equal(r.status, 200, d.message);
    assert.match(d.message, /Token saved\. Fig is starting/);
    assert.ok(!JSON.stringify(d).includes(TOKEN), 'the token is never sent back');
    const file = path.join(p.dataDir, 'discord-token');
    assert.equal(fs.readFileSync(file, 'utf8').trim(), TOKEN);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    s = p.state();
    assert.equal(s.token, 'panel');
    assert.equal(s.running, true);
    const sup = s.supervisor.pid;

    // The token is already saved: Start alone is enough, and a second start is refused.
    r = await post(p.url(), 'start');
    assert.equal(r.status, 409);

    r = await post(p.url(), 'stop');
    assert.equal(r.status, 200);
    s = p.state();
    assert.equal(s.running, false);
    assert.equal(s.stoppedOnPurpose, true);
    assert.throws(() => process.kill(sup, 0));

    // Anything else that tries to start Fig now (boot hook, cron, scheduled task) is refused.
    const { spawnSync } = require('node:child_process');
    const direct = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'supervise.js')], {
      env: { ...process.env, FIG_PANEL_DATA: p.dataDir, FIG_LOGS_DIR: p.logsDir, FIG_ENTRY: path.join(__dirname, 'fixtures', 'panel-fake-fig.js') },
      timeout: 10000,
    });
    assert.equal(direct.status, 0);
    assert.match(fs.readFileSync(path.join(p.logsDir, 'crash.log'), 'utf8'), /not starting: Fig was stopped from the control panel/);
    assert.equal(p.state().running, false);

    // Saved token + Start = running again, and the "stopped on purpose" flag is gone.
    r = await post(p.url(), 'start');
    assert.equal(r.status, 200, (await r.json()).message);
    s = p.state();
    assert.equal(s.running, true);
    assert.equal(s.stoppedOnPurpose, false);

    r = await post(p.url(), 'restart');
    assert.equal(r.status, 200);
    assert.notEqual(p.state().supervisor.pid, s.supervisor.pid);
    assert.equal(p.state().running, true);
  } finally {
    await p.actions.stop('test cleanup');
    p.server.close();
    p.restore();
  }
});

test('with a key, nothing works until you log in, and POSTs need the page header', async () => {
  const p = setup({ key: 'hunter2-panel' });
  await p.listening;
  try {
    assert.equal((await fetch(`${p.url()}/api/state`)).status, 401);
    const html = await (await fetch(`${p.url()}/`)).text();
    assert.match(html, /data-login="1"/);
    const bad = await fetch(`${p.url()}/login`, { method: 'POST', body: 'key=nope', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    assert.equal(bad.headers.get('set-cookie'), null);
    const ok = await fetch(`${p.url()}/login`, { method: 'POST', body: 'key=hunter2-panel', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await fetch(`${p.url()}/api/state`, { headers: { cookie } })).status, 200);
    const noHeader = await fetch(`${p.url()}/api/start`, { method: 'POST', headers: { cookie } });
    assert.equal(noHeader.status, 403);
    // Live log proxy answers even while Fig is down.
    const fig = await fetch(`${p.url()}/fig/`, { headers: { cookie } });
    assert.equal(fig.status, 502);
    assert.match(await fig.text(), /Press Start/);
  } finally {
    p.server.close();
    p.restore();
  }
});

test('Fig reads a token saved by the panel before DISCORD_TOKEN', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fig-tok-'));
  const f = path.join(dir, 'discord-token');
  fs.writeFileSync(f, `${TOKEN}\n`);
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', "process.stdout.write(require('./src/config').config.discordToken)"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, FIG_TOKEN_FILE: f, DISCORD_TOKEN: 'old.revoked.token' },
  }).toString();
  assert.equal(out, TOKEN);
});
