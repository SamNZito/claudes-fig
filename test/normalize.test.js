'use strict';
// Same pipeline with loudness normalisation on (the default), to make sure the ffmpeg filter chain works.
process.env.NORMALIZE_AUDIO = 'true';
const { waitFor } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { TrackSource } = require('../src/audio/trackSource');

test('loudnorm pipeline produces audio', async () => {
  const src = new TrackSource({ url: 'https://www.youtube.com/watch?v=tone-n', title: 'n', duration: 6 }).start();
  assert.ok(await waitFor(() => src.pcm.hasData, 8000));
  src.destroy();
});

test('resume from an offset starts mid-song', async () => {
  const src = new TrackSource({ url: 'https://www.youtube.com/watch?v=tone-o', title: 'o', duration: 6 }, { startSec: 4 }).start();
  // (fake yt-dlp honours --download-sections like the real one)
  let ended = null;
  src.on('ended', (e) => (ended = e));
  assert.ok(await waitFor(() => src.pcm.inputEnded, 8000));
  // ~2 s of audio left after skipping the first 4 s
  const secs = src.pcm.received / 192000;
  assert.ok(secs > 1 && secs < 3.5, `got ${secs}s`);
  while (src.pcm.hasData) src.pcm.read(3840);
  assert.ok(await waitFor(() => ended, 3000));
  assert.strictEqual(ended.early, false);
});
