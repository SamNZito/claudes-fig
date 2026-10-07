'use strict';
// Audio core: real ffmpeg, fake yt-dlp.
const { waitFor, sleep, track, rms, pull } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { Mixer } = require('../src/audio/mixer');
const { MusicPlayer } = require('../src/music/player');
const { PcmSource } = require('../src/audio/pcmSource');
const sources = require('../src/music/sources');
const store = require('../src/store');

function setup(guild) {
  sources.reset();
  const mixer = new Mixer({ volume: 100 });
  const player = new MusicPlayer({ guildId: guild, mixer });
  player.setVolume(100);
  return { mixer, player };
}
const req = (player, t, extra = {}) => player.makeEntry({ asked: t.title, candidates: [t], explicit: true, ...extra });

test('a song is only "now playing" once audio is pulled, and it is audible', async () => {
  const { mixer, player } = setup('g1');
  let np = null;
  player.on('nowPlaying', (e) => (np = e));
  player.enqueue([req(player, track('tone1'))]);
  assert.ok(await waitFor(() => mixer.music && mixer.music.hasData));
  assert.strictEqual(np, null, 'must not claim playing before audio goes out');
  const frames = await pull(mixer, 20);
  await sleep(5);
  assert.ok(np && np.key === 'soundcloud:tone1');
  assert.ok(rms(frames[15]) > 1000, 'tone should be audible');
  player.destroy();
});

test('skip drops the old song immediately: next frames are the new song, never the old one', async () => {
  const { mixer, player } = setup('g2');
  player.enqueue([req(player, track('tone2', 'First Song')), req(player, track('noise2', 'Other Thing'))]);
  assert.ok(await waitFor(() => mixer.music && mixer.music.hasData));
  await pull(mixer, 10);
  player.skip();
  const f = mixer.nextFrame();
  assert.ok(rms(f) < 1, 'first frame after skip must not contain the skipped song');
  assert.ok(await waitFor(() => player.current?.status !== 'resolving' && mixer.music && mixer.music.hasData));
  const frames = await pull(mixer, 30);
  assert.ok(frames.some((x) => rms(x) > 500), 'the next song plays');
  assert.strictEqual(player.current.entry.key, 'soundcloud:noise2');
  player.destroy();
});

test('pause stays paused even while Fig talks', async () => {
  const { mixer, player } = setup('g3');
  player.enqueue([req(player, track('tone3'))]);
  assert.ok(await waitFor(() => mixer.music && mixer.music.hasData));
  await pull(mixer, 10);
  player.pause();
  const pos = mixer.music.positionMs;
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
  player.enqueue([req(player, track('tone4'))]);
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

test('volume changes never stop or restart the song', async () => {
  const { mixer, player } = setup('g-vol');
  let ended = 0;
  player.on('idle', () => ended++);
  player.enqueue([req(player, track('tone-vol'))]);
  assert.ok(await waitFor(() => mixer.music && mixer.music.hasData));
  await pull(mixer, 20);
  const cur = player.current;
  const pos = cur.source.positionMs;
  player.setVolume(30);
  player.setVolume(10);
  await pull(mixer, 5);
  assert.strictEqual(player.current, cur, 'same song keeps playing');
  assert.ok(cur.source.positionMs > pos);
  assert.strictEqual(ended, 0);
  player.destroy();
});

test('a stream that never delivers audio fails with a timeout instead of pretending', async () => {
  const { player } = setup('g6');
  let failed = null;
  player.on('trackFailed', (e, reason) => (failed = reason));
  player.enqueue([req(player, track('slow1'))]);
  assert.ok(await waitFor(() => failed !== null, 12000));
  assert.match(failed, /timed out/);
  player.destroy();
});

test('song ends naturally and the queue advances; idle when empty', async () => {
  const { mixer, player } = setup('g7');
  let idle = false;
  player.on('idle', () => (idle = true));
  player.enqueue([req(player, track('tone7'))]);
  assert.ok(await waitFor(() => mixer.music && mixer.music.hasData));
  for (let i = 0; i < 40 && !idle; i++) await pull(mixer, 20);
  assert.ok(await waitFor(() => idle, 5000));
  assert.strictEqual(player.current, null);
  player.destroy();
});

test('same title, different uploads are separate queue entries; removal by position keeps current', async () => {
  const { player } = setup('g8');
  player.queue.add([req(player, track('a', 'Same Song')), req(player, track('b', 'Same Song'))]);
  assert.strictEqual(player.queue.length, 2);
  const removed = player.remove('2');
  assert.strictEqual(removed.key, 'soundcloud:b');
  assert.strictEqual(player.queue.items[0].key, 'soundcloud:a');
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

test('history is recorded with the asked text and the copy that played', async () => {
  const { mixer, player } = setup('g-hist');
  player.enqueue([player.makeEntry({ asked: 'my request', candidates: [track('tone-h', 'Uploaded Title')], explicit: true })]);
  assert.ok(await waitFor(() => mixer.music && mixer.music.hasData));
  await pull(mixer, 5);
  assert.ok(await waitFor(() => store.history('g-hist').length === 1));
  const h = store.history('g-hist')[0];
  assert.strictEqual(h.asked, 'my request');
  assert.strictEqual(h.title, 'Uploaded Title');
  assert.strictEqual(h.id, 'soundcloud:tone-h');
  player.destroy();
});
