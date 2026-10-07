'use strict';
// Keeps exactly one Fig running.
//   - restarts it if it exits (with backoff)
//   - restarts it if it HANGS: Fig sends a heartbeat over IPC every 10 s; 90 s of silence = kill + restart
//   - restarts it after the machine was FROZEN/suspended (this supervisor's own timer jumped), because
//     the Discord gateway and voice connections are dead after a long freeze even if Node survived
//   - refuses to start a second copy (a second client on the same token kicks Fig out of voice)
// It cannot bring itself back after a machine reboot. Something outside has to start it:
// scripts/ensure-running.sh (cron / boot hook), the systemd unit, or the Windows scheduled task.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const entry = process.env.FIG_ENTRY || path.join(ROOT, 'src', 'index.js');
const LOGS = process.env.FIG_LOGS_DIR || path.join(ROOT, 'logs');
const crashFile = path.join(LOGS, 'crash.log');
const pidFile = path.join(LOGS, 'supervisor.pid');

const HANG_MS = Number(process.env.FIG_HANG_SEC || 90) * 1000;
const TICK_MS = Math.min(5000, Math.max(200, HANG_MS / 6));
const FREEZE_MS = Number(process.env.FIG_FREEZE_SEC || 60) * 1000; // our timer firing this late = the machine was paused

function note(msg) {
  const line = `${new Date().toISOString()} [supervise pid=${process.pid}] ${msg}\n`;
  try {
    fs.mkdirSync(LOGS, { recursive: true });
    fs.appendFileSync(crashFile, line);
  } catch {
    /* ignore */
  }
  console.error(line.trim());
}

function alive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e.code === 'EPERM';
  }
  // A killed process can linger as a zombie; that is not a running Fig.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (stat.split(') ').pop().trim().startsWith('Z')) return false;
  } catch {
    /* not linux */
  }
  return true;
}

// ---- single instance ----
try {
  const old = Number(String(fs.readFileSync(pidFile, 'utf8')).trim());
  if (alive(old)) {
    note(`another supervisor is already running (pid ${old}); exiting so only one Fig runs`);
    process.exit(0);
  }
} catch {
  /* no pid file */
}
fs.mkdirSync(LOGS, { recursive: true });
fs.writeFileSync(pidFile, String(process.pid));
const releasePid = () => {
  try {
    if (Number(fs.readFileSync(pidFile, 'utf8')) === process.pid) fs.unlinkSync(pidFile);
  } catch {
    /* ignore */
  }
};
process.on('exit', releasePid);

let restarts = 0;
let lastStart = 0;
let lastBeat = 0;
let child = null;
let stopping = false;
let restartTimer = null;
let killReason = null;

function start() {
  restartTimer = null;
  lastStart = Date.now();
  lastBeat = Date.now();
  killReason = null;
  note(`starting ${entry}`);
  child = spawn(process.execPath, [entry], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: { ...process.env, FIG_SUPERVISED: '1' } });
  child.on('message', (m) => {
    if (m && m.type === 'beat') lastBeat = Date.now();
  });
  child.on('exit', (code, signal) => {
    const was = child;
    child = null;
    if (stopping) {
      note(`child exit during shutdown code=${code} signal=${signal}`);
      releasePid();
      process.exit(0);
    }
    if (!killReason && code === 1 && Date.now() - lastStart < 5000) {
      note(`child died during startup code=${code}. Check .env / npm run doctor. Retrying in 60s.`);
      scheduleStart(60000);
      return;
    }
    if (Date.now() - lastStart > 10 * 60 * 1000) restarts = 0;
    restarts++;
    const delay = killReason ? 1000 : Math.min(30000, 1000 * 2 ** Math.min(restarts, 5));
    note(`child pid=${was?.pid} exited code=${code} signal=${signal}${killReason ? ` (${killReason})` : ''}. Restarting in ${delay / 1000}s (restart #${restarts}).`);
    scheduleStart(delay);
  });
}

function scheduleStart(ms) {
  if (restartTimer) return;
  restartTimer = setTimeout(start, ms);
}

function killChild(reason) {
  if (!child || killReason) return;
  killReason = reason;
  note(`killing child pid=${child.pid}: ${reason}`);
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const gap = now - lastTick;
  lastTick = now;
  if (gap > FREEZE_MS) {
    note(`machine was frozen/suspended for ~${Math.round(gap / 1000)}s; restarting Fig so it reconnects cleanly`);
    killChild(`frozen for ${Math.round(gap / 1000)}s`);
    return;
  }
  if (child && now - lastBeat > HANG_MS) killChild(`no heartbeat for ${Math.round((now - lastBeat) / 1000)}s (event loop stuck)`);
}, TICK_MS);

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopping = true;
    note(`supervisor got ${sig}; stopping Fig`);
    if (child) child.kill('SIGTERM');
    else {
      releasePid();
      process.exit(0);
    }
    setTimeout(() => {
      releasePid();
      process.exit(0);
    }, 8000).unref();
  });
}

start();
