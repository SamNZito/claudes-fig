'use strict';
// The supervisor restarts a Fig that hangs (no heartbeat) and refuses to run twice.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SUP = path.join(__dirname, '..', 'scripts', 'supervise.js');

function startSupervisor(dir, mode) {
  return spawn(process.execPath, [SUP], {
    env: {
      ...process.env,
      FIG_ENTRY: path.join(__dirname, 'fixtures', 'fake-fig.js'),
      FIG_LOGS_DIR: dir,
      FIG_HANG_SEC: '1.5',
      FAKE_FIG_MODE: mode,
      FAKE_FIG_STARTS: path.join(dir, 'starts'),
    },
    stdio: 'ignore',
  });
}
const starts = (dir) => (fs.existsSync(path.join(dir, 'starts')) ? fs.readFileSync(path.join(dir, 'starts'), 'utf8').split('\n').filter(Boolean) : []);

test('a hung Fig (event loop stuck, no heartbeat) is killed and restarted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figsup-'));
  const sup = startSupervisor(dir, 'hang');
  try {
    for (let i = 0; i < 60 && starts(dir).length < 2; i++) await sleep(100);
    assert.ok(starts(dir).length >= 2, `restarted after hang (starts=${starts(dir).length})`);
    assert.match(fs.readFileSync(path.join(dir, 'crash.log'), 'utf8'), /no heartbeat/);
  } finally {
    sup.kill('SIGKILL');
    for (const pid of starts(dir)) try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ }
  }
});

test('a crashed Fig is restarted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figsup-'));
  const sup = startSupervisor(dir, 'exit');
  try {
    for (let i = 0; i < 60 && starts(dir).length < 2; i++) await sleep(100);
    assert.ok(starts(dir).length >= 2);
  } finally {
    sup.kill('SIGKILL');
    for (const pid of starts(dir)) try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ }
  }
});

test('a second supervisor refuses to start (one bot per token)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figsup-'));
  const a = startSupervisor(dir, 'none');
  try {
    for (let i = 0; i < 30 && !fs.existsSync(path.join(dir, 'supervisor.pid')); i++) await sleep(100);
    const b = startSupervisor(dir, 'none');
    const code = await new Promise((r) => b.on('exit', r));
    assert.strictEqual(code, 0);
    assert.match(fs.readFileSync(path.join(dir, 'crash.log'), 'utf8'), /already running/);
    assert.strictEqual(starts(dir).length, 1);
  } finally {
    a.kill('SIGKILL');
    for (const pid of starts(dir)) try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ }
  }
});

test('after the machine was frozen (supervisor paused), Fig is restarted so it reconnects clean', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figsup-'));
  const sup = spawn(process.execPath, [SUP], {
    env: { ...process.env, FIG_ENTRY: path.join(__dirname, 'fixtures', 'fake-fig.js'), FIG_LOGS_DIR: dir, FIG_HANG_SEC: '30', FIG_FREEZE_SEC: '1.5', FAKE_FIG_MODE: 'none', FAKE_FIG_STARTS: path.join(dir, 'starts') },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 30 && starts(dir).length < 1; i++) await sleep(100);
    process.kill(sup.pid, 'SIGSTOP');
    await sleep(2500);
    process.kill(sup.pid, 'SIGCONT');
    for (let i = 0; i < 50 && starts(dir).length < 2; i++) await sleep(100);
    assert.ok(starts(dir).length >= 2, 'restarted after freeze');
    assert.match(fs.readFileSync(path.join(dir, 'crash.log'), 'utf8'), /frozen/);
  } finally {
    sup.kill('SIGKILL');
    for (const pid of starts(dir)) try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ }
  }
});
