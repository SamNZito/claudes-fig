'use strict';
// Audio core tests using a fake yt-dlp that streams local files through real ffmpeg.
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
process.env.YTDLP_PATH = path.join(__dirname, 'fixtures', 'fake-ytdlp.js');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'figtest-'));
process.env.NORMALIZE_AUDIO = 'false';
process.env.TRACK_START_TIMEOUT_SEC = '3';
process.env.LOG_LEVEL = 'error';
try { fs.chmodSync(process.env.YTDLP_PATH, 0o755); } catch { /* windows */ }

const test = require('node:test');
const assert = require('node:assert');
const { Mixer } = require('../src/audio/mixer');
const { MusicPlayer } = require('../src/music/player');
const { Queue } = require('../src/music/queue');
const { PcmSource } = require('../src/audio/pcmSource');
const store = require('../src/store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rms(buf) {
  let s = 0;
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    s += v * v;
  }
  return Math.sqrt(s / n);
}
function track(id, title = id) {
  return { key: `youtube:${id}`, id, url: `https://www.youtube.com/watch?v=${id}`, title, channel: 'Fake', duration: 6 };
}
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}
/** Pull frames like the Discord player would (faster than real time). */
async function pull(mixer, frames) {
  const out = [];
  for (let i = 0; i < frames; i++) {
    out.push(mixer.nextFrame());
    if (i % 10 === 0) await sleep(1);
  }
  return out;
}

function setup(guild) {
  const mixer = new Mixer({ volume: 100 });
  const player = new MusicPlayer({ guildId: guild, mixer });
  player.setVolume(100);
  return { mixer, player };
}

test('a parody title still counts as the same song', () => {
  const { player } = setup('g-match');
  const entry = {
    query: 'Mint sings the Monster Mash',
    title: 'Mint sings the Monster Mash (ZOOMER BRAINROT EDITION)',
    asked: 'Mint sings the Monster Mash (ZOOMER BRAINROT EDITION)',
  };
  assert.ok(player._songScore(entry, { title: 'Brainrot Bash (Monster Mash Brainrot Parody)', channel: '' }) > 0);
  assert.strictEqual(player._songScore(entry, { title: 'Monster Mash', channel: 'Bobby' }), 0);
  assert.ok(player._scQueries(entry).includes('brainrot monster mash'));
  player.destroy();
});

test('a skipped song is not eligible to start again', () => {
  const { player } = setup('g-skipblock');
  const entry = { key: 'soundcloud:1', title: 'Till I Collapse', asked: 'Till I Collapse', query: 'eminem till i collapse', uid: 1, via: 'user' };
  player._blockSong(entry);
  assert.ok(player._skipBlocked(entry));
  assert.ok(player._skipBlocked({ key: 'soundcloud:999', title: 'Till I Collapse (feat. Nate Dogg)', via: 'dj' }));
  player._forgetSkip(entry);
  player._forgetSkip('eminem till i collapse');
  assert.strictEqual(player._skipBlocked({ key: 'soundcloud:999', title: 'something else', via: 'user' }), null);
  player.destroy();
});

test('play now while idle keeps the song instead of skipping it', async () => {
  const { mixer, player } = setup('g-now');
  const res = await player.request('tone now', { playNow: true });
  assert.strictEqual(res.ok, true);
  assert.ok(await waitFor(() => player.current && player.current.entry.id === 'tone-now-0'));
  assert.ok(await waitFor(() => mixer.music && mixer.music.hasData));
  await sleep(80);
  assert.strictEqual(player.current.entry.id, 'tone-now-0');
  player.destroy();
});

test('a song is only "now playing" once audio is pulled, and it is audible', async () => {
  const { mixer, player } = setup('g1');
  let np = null;
  player.on('nowPlaying', (e) => (np = e));
  player.enqueue([Queue.entry(track('tone1'))]);
  assert.ok(await waitFor(() => mixer.music && mixer.music.hasData));
  assert.strictEqual(np, null, 'must not claim playing before audio goes out');
  const frames = await pull(mixer, 20);
  await sleep(5);
  assert.ok(np && np.id === 'tone1');
  assert.ok(rms(frames[15]) > 1000, 'tone should be audible');
  player.destroy();
});

test('skip drops the old song immediately: next frames are the new song, never the old one', async () => {
  const { mixer, player } = setup('g2');
  player.enqueue([Queue.entry(track('tone2')), Queue.entry(track('noise2'))]);
  assert.ok(await waitFor(() => mixer.music && mixer.music.hasData));
  await pull(mixer, 10);
  player.skip();
  // Right after skip, no audio from the tone remains anywhere.
  const f = mixer.nextFrame();
  assert.ok(rms(f) < 1, 'first frame after skip must not contain the skipped song');
  assert.ok(await waitFor(() => mixer.music && mixer.music.hasData));
  const frames = await pull(mixer, 30);
  assert.ok(frames.some((x) => rms(x) > 500), 'the next song plays');
  assert.strictEqual(player.current.entry.id, 'noise2');
  const hist = store.history('g2').map((h) => h.id);
  assert.ok(hist.includes('youtube:tone2'), 'skipped song is remembered');
  player.destroy();
});

test('pause stays paused even while Fig talks', async () => {
  const { mixer, player } = setup('g3');
  player.enqueue([Queue.entry(track('tone3'))]);
  assert.ok(await waitFor(() => mixer.music && mixer.music.hasData));
  await pull(mixer, 10);
  player.pause();
  const pos = mixer.music.positionMs;
  // Fig speaks a 200 ms clip of silence-ish voice
  const clip = new PcmSource();
  clip.push(Buffer.alloc(3840 * 10));
  clip.end();
  const done = mixer.addVoice(clip);
  await pull(mixer, 30);
  assert.strictEqual(await done, true);
  assert.strictEqual(player.paused, true);
  assert.strictEqual(mixer.musicPaused, true);
  assert.strictEqual(mixer.music.positionMs, pos, 'music must not advance while paused');
  const after = await pull(mixer, 5);
  assert.ok(after.every((x) => rms(x) < 1), 'still silent after Fig stops talking');
  player.resume();
  const resumed = await pull(mixer, 5);
  assert.ok(resumed.some((x) => rms(x) > 500));
  player.destroy();
});

test('music ducks under Fig speaking', async () => {
  const { mixer, player } = setup('g4');
  player.enqueue([Queue.entry(track('tone4'))]);
  assert.ok(await waitFor(() => mixer.music && mixer.music.hasData));
  const before = await pull(mixer, 10);
  const loud = rms(before[9]);
  const clip = new PcmSource();
  clip.push(Buffer.alloc(3840 * 40));
  clip.end();
  mixer.addVoice(clip);
  const during = await pull(mixer, 20);
  assert.ok(rms(during[19]) < loud * 0.5, `ducked (${rms(during[19])} vs ${loud})`);
  player.destroy();
});

test('a YouTube block skips more YouTube copies and plays SoundCloud', async () => {
  const { mixer, player } = setup('g-sc');
  let failed = null;
  player.on('trackFailed', (e, r) => (failed = r));
  const entry = Queue.entry(track('bot1', 'Ark Patrol - Let Go'), { via: 'user' });
  entry.query = 'tone song';
  entry.asked = entry.title;
  entry.altTracks = [track('slowhang', 'slowed and reverbed')];
  player.enqueue([entry]);
  assert.ok(await waitFor(() => player.current && player.current.entry.id === 'tone-song-0', 8000));
  assert.ok(await waitFor(() => mixer.music && mixer.music.hasData));
  assert.strictEqual(failed, null);
  assert.strictEqual(player.current.entry.asked, 'Ark Patrol - Let Go');
  player.destroy();
});

test('an age-restricted upload falls through instead of stopping', async () => {
  const { player } = setup('g-age');
  let failed = null;
  player.on('trackFailed', (e, r) => (failed = { title: e.title, r }));
  const entry = Queue.entry(track('age1', 'Official'), { via: 'user' });
  entry.query = 'bad song';
  entry.asked = 'Ark Patrol - Let Go';
  player.enqueue([entry]);
  assert.ok(await waitFor(() => failed, 8000));
  assert.strictEqual(failed.title, 'Ark Patrol - Let Go');
  assert.ok(failed.r);
  player.destroy();
});

test('unplayable song is reported and the next one plays', async () => {
  const { mixer, player } = setup('g5');
  let failed = null;
  player.on('trackFailed', (e, reason) => (failed = { e, reason }));
  player.enqueue([Queue.entry(track('bad1')), Queue.entry(track('tone5'))]);
  assert.ok(await waitFor(() => failed !== null, 8000));
  assert.match(failed.reason, /unavailable/);
  assert.ok(await waitFor(() => player.current && player.current.entry.id === 'tone5'));
  player.destroy();
});

test('a stream that never delivers audio fails with a timeout instead of pretending', async () => {
  const { player } = setup('g6');
  let failed = null;
  player.on('trackFailed', (e, reason) => (failed = reason));
  player.enqueue([Queue.entry(track('slow1'))]);
  assert.ok(await waitFor(() => failed !== null, 8000));
  assert.match(failed, /timed out/);
  player.destroy();
});

test('song ends naturally and the queue advances; idle when empty', async () => {
  const { mixer, player } = setup('g7');
  let idle = false;
  player.on('idle', () => (idle = true));
  player.enqueue([Queue.entry(track('tone7'))]);
  assert.ok(await waitFor(() => mixer.music && mixer.music.hasData));
  // 6 s of audio = 300 frames
  for (let i = 0; i < 40 && !idle; i++) await pull(mixer, 20);
  assert.ok(await waitFor(() => idle, 5000));
  assert.strictEqual(player.current, null);
  player.destroy();
});

test('same title, different uploads are separate queue entries; removal by position keeps current', async () => {
  const { player } = setup('g8');
  player.queue.add([Queue.entry(track('a', 'Same Song')), Queue.entry(track('b', 'Same Song'))]);
  assert.strictEqual(player.queue.length, 2);
  const removed = player.remove('2');
  assert.strictEqual(removed.id, 'b');
  assert.strictEqual(player.queue.items[0].id, 'a');
  player.destroy();
});

test('mixer goes idle when nothing is audible and wakes for speech', async () => {
  const mixer = new Mixer();
  let idle = 0;
  let active = 0;
  mixer.on('idle', () => idle++);
  mixer.on('active', () => active++);
  mixer.wake();
  await pull(mixer, 20);
  assert.strictEqual(idle, 1);
  const clip = new PcmSource();
  clip.push(Buffer.alloc(3840));
  clip.end();
  mixer.addVoice(clip);
  assert.strictEqual(active, 2);
});
