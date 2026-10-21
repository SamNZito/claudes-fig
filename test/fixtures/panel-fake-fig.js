'use strict';
// Stands in for src/index.js under the real supervisor: writes a heartbeat and stays up until told to stop.
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FIG_LOGS_DIR;
const beat = () => {
  fs.writeFileSync(path.join(dir, 'heartbeat'), `${Date.now()} ${process.pid}\n`);
  if (process.send) process.send({ type: 'beat' });
};
fs.writeFileSync(path.join(dir, 'fig.pid'), String(process.pid));
beat();
setInterval(beat, 200);
process.on('SIGTERM', () => process.exit(0));
