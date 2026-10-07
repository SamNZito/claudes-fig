'use strict';
// Child process for supervisor tests. FAKE_FIG_MODE: "hang" (beats, then blocks the event loop) or "exit".
const fs = require('node:fs');
const mode = process.env.FAKE_FIG_MODE;
fs.appendFileSync(process.env.FAKE_FIG_STARTS, `${process.pid}\n`);
const beat = () => process.send && process.send({ type: 'beat' });
beat();
const t = setInterval(beat, 100);
if (mode === 'hang') setTimeout(() => { clearInterval(t); for (;;) {} }, 300);
if (mode === 'exit') setTimeout(() => process.exit(3), 300);
