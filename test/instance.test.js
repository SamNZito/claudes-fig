'use strict';
// Two copies of Fig on one token: detect it and step aside instead of fighting over voice.
const { fakeGuild, fakeMember } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { InstanceGuard } = require('../src/discord/instanceGuard');
const { GuildSession } = require('../src/voice/session');
const store = require('../src/store');

test('a voice state for our bot under another gateway session is foreign; our own sessions are not', () => {
  const g = new InstanceGuard();
  assert.strictEqual(g.isForeign({ channelId: 'vc', sessionId: 'x' }), false, 'nothing known yet');
  g.onRaw({ t: 'READY', d: { session_id: 'ours-1' } });
  assert.strictEqual(g.isForeign({ channelId: 'vc', sessionId: 'ours-1' }), false);
  assert.strictEqual(g.isForeign({ channelId: 'vc', sessionId: 'other' }), true);
  assert.strictEqual(g.isForeign({ channelId: null, sessionId: 'other' }), false, 'not in voice');
  g.onRaw({ t: 'READY', d: { session_id: 'ours-2' } }); // reconnect with a new session
  assert.strictEqual(g.isForeign({ channelId: 'vc', sessionId: 'ours-1' }), false, 'an old session of ours is still ours');
});

test('standing by drops the connection WITHOUT sending a leave, and never rejoins', async () => {
  const guild = fakeGuild('inst1');
  fakeMember(guild, 'a', 'A', { admin: true });
  const s = new GuildSession({}, guild);
  store.setDj('inst1', { enabled: true, mood: 'chill' });
  let destroyArg = 'not called';
  s.connection = { state: { status: 'ready' }, destroy: (arg) => (destroyArg = arg) };
  s.wantConnected = true;
  s.standBy();
  assert.strictEqual(destroyArg, false, 'destroy(false): do not kick the other copy out of voice');
  assert.strictEqual(s.connection, null);
  s.scheduleRejoin();
  assert.strictEqual(s.rejoinAttempt, 0, 'no rejoin scheduled');
  await assert.rejects(() => s.join({ id: 'vc', name: 'zzzz' }), /another copy/);
  assert.strictEqual(store.dj('inst1').enabled, true, 'DJ setting kept for later');
  s.leaveStandby();
  assert.strictEqual(s.standby, false);
  s.destroy();
});

test('a second copy on the same token refuses to start, even from another folder (exit 64)', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { spawn } = require('node:child_process');
  const token = `test-token-${Math.random()}`;
  const tag = crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
  const lock = path.join(os.tmpdir(), `fig-${tag}.pid`);
  // Pretend a copy in some other folder holds the token: this test process is the "other copy".
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, dir: '/somewhere/else/claudes_fig', at: Date.now() }));
  try {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
      env: { ...process.env, DISCORD_TOKEN: token, XAI_API_KEY: 'x', FIG_LOG: path.join(os.tmpdir(), 'fig-lock-test.log') },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    const code = await new Promise((r) => child.on('exit', r));
    assert.strictEqual(code, 64);
    assert.match(err, /already running with this bot token/);
  } finally {
    fs.unlinkSync(lock);
  }
});
