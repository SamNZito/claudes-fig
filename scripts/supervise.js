'use strict';
// Keeps Fig running: restarts it if it ever exits unexpectedly (with backoff).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const entry = path.join(__dirname, '..', 'src', 'index.js');
const crashFile = path.join(__dirname, '..', 'logs', 'crash.log');

function crash(msg) {
  const line = `${new Date().toISOString()} [supervise] ${msg}\n`;
  try {
    fs.mkdirSync(path.dirname(crashFile), { recursive: true });
    fs.appendFileSync(crashFile, line);
  } catch {
    /* ignore */
  }
  console.error(line.trim());
}
let restarts = 0;
let lastStart = 0;
let child = null;
let stopping = false;

function start() {
  lastStart = Date.now();
  crash(`starting ${entry}`);
  child = spawn(process.execPath, [entry], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (stopping) {
      crash(`child exit during shutdown code=${code} signal=${signal}`);
      return process.exit(0);
    }
    if (code === 1 && Date.now() - lastStart < 5000) {
      crash(`child died during startup code=${code} signal=${signal}. Not restarting.`);
      console.error('[supervise] Fig exited during startup (check .env and `npm run doctor`). Not restarting.');
      return process.exit(1);
    }
    if (Date.now() - lastStart > 60000) restarts = 0;
    restarts++;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(restarts, 5));
    crash(`child exited code=${code} signal=${signal}. Restarting in ${delay / 1000}s (restart #${restarts}).`);
    console.error(`[supervise] Fig exited (code ${code}, signal ${signal}). Restarting in ${delay / 1000}s...`);
    setTimeout(start, delay);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill(sig);
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

start();
