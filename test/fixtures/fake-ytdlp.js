#!/usr/bin/env node
'use strict';
// Stand-in for yt-dlp in tests. Search returns fake entries; downloading "streams" a local file.
//   ids starting with "tone" -> tone.mp3, "noise" -> noise.mp3, "bad" -> error, "slow" -> waits forever
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const last = args[args.length - 1] || '';

if (args.includes('--dump-json')) {
  const m = last.match(/^(yt|sc)search(\d+):(.*)$/);
  if (m) {
    const q = m[3].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const n = Number(m[2]);
    for (let i = 0; i < n; i++) {
      const id = `${q}-${i}`;
      console.log(JSON.stringify({ id, title: `${m[3].trim()} #${i}`, duration: Number(process.env.FAKE_DURATION || 6), channel: 'Fake', ie_key: 'Youtube', url: `https://www.youtube.com/watch?v=${id}` }));
    }
    process.exit(0);
  }
  const id = (last.match(/v=([^&]+)/) || [])[1] || 'x';
  console.log(JSON.stringify({ id, title: `Video ${id}`, duration: 6, channel: 'Fake', extractor_key: 'Youtube', webpage_url: last }));
  process.exit(0);
}

const id = (last.match(/v=([^&]+)/) || [])[1] || '';
if (id.startsWith('bad')) {
  process.stderr.write('ERROR: [youtube] bad: Video unavailable\n');
  process.exit(1);
}
if (id.startsWith('age')) {
  process.stderr.write('ERROR: [youtube] age: This video is age-restricted\n');
  process.exit(1);
}
if (id.startsWith('bot')) {
  process.stderr.write("ERROR: [youtube] bot: Sign in to confirm you're not a bot\n");
  process.exit(1);
}
if (id.startsWith('slow')) {
  setInterval(() => {}, 1000);
} else {
  const file = path.join(__dirname, id.startsWith('noise') ? 'noise.mp3' : 'tone.mp3');
  fs.createReadStream(file).pipe(process.stdout);
}
