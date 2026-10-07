'use strict';
const { script, waitFor } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { createAudioResource, StreamType } = require('@discordjs/voice');
const { Mixer } = require('../src/audio/mixer');
const { MusicPlayer } = require('../src/music/player');
const { DJ } = require('../src/music/dj');
const { songKey, search } = require('../src/music/search');
const { decodeToPcm, speakable, forText } = require('../src/audio/tts');
const { toWav16kMono } = require('../src/voice/listener');
const actions = require('../src/actions');
const store = require('../src/store');
const fs = require('node:fs');
const path = require('node:path');

function djSetup(gid) {
  const mixer = new Mixer({ volume: 50 });
  const player = new MusicPlayer({ guildId: gid, mixer });
  const dj = new DJ({ guildId: gid, player });
  return { mixer, player, dj };
}

test('DJ picks are requests (artist - title); the player resolves the copy', async () => {
  const { player, dj } = djSetup('djq');
  dj.enabled = true;
  dj.mood = 'epic';
  dj.pending = [{ asked: 'Tone - Alpha' }];
  await dj.refill({ urgent: true });
  const e = player.current?.entry || player.queue.items[0];
  assert.ok(e, 'DJ queued a song');
  assert.strictEqual(e.asked, 'Tone - Alpha');
  assert.strictEqual(e.via, 'dj');
  player.destroy();
});

test('DJ starts music in a mood and keeps songs queued', async () => {
  const { player, dj } = djSetup('dj1');
  script.json.push({ songs: [{ artist: 'Tone', title: 'Alpha' }, { artist: 'Tone', title: 'Beta' }, { artist: 'Tone', title: 'Gamma' }, { artist: 'Tone', title: 'Delta' }] });
  dj.turnOn('test vibes');
  assert.ok(await waitFor(() => player.current, 5000), 'DJ started a song');
  assert.ok(await waitFor(() => player.queue.count((e) => e.via === 'dj') >= 1, 5000), 'DJ queued more');
  assert.strictEqual(player.current.entry.via, 'dj');
  dj.turnOff();
  player.destroy();
});

test('DJ memory: never re-picks a song that already played, under any upload or wording', async () => {
  const gid = 'dj2';
  store.addHistory(gid, { id: 'youtube:abc', key: songKey('Tone - Alpha (Official Video)'), title: 'Tone - Alpha (Official Video)', channel: 'ToneVEVO', asked: 'Tone - Alpha', via: 'dj' });
  const { player, dj } = djSetup(gid);
  assert.ok(dj.rejectReason({ asked: 'Tone - Alpha' }));
  assert.ok(dj.rejectReason({ asked: 'Alpha', track: { key: 'soundcloud:9', title: 'Alpha (2013 Remaster)', channel: 'Tone' } }));
  assert.strictEqual(dj.rejectReason({ asked: 'Tone - Beta' }), null);
  player.destroy();
});

test('user can request the same song again on purpose', async () => {
  const gid = 'dj3';
  store.addHistory(gid, { id: 'soundcloud:sc-again-0', key: 'again', title: 'again #0', via: 'user' });
  const { player } = djSetup(gid);
  const r = await player.request('again');
  assert.ok(r.ok);
  assert.ok(await waitFor(() => player.current?.track?.key === 'soundcloud:sc-again-0', 8000));
  player.destroy();
});

test('changing DJ mood drops queued DJ songs but keeps user songs', async () => {
  const { player, dj } = djSetup('dj4');
  dj.enabled = true;
  dj.mood = 'old';
  player.queue.add([player.makeEntry({ asked: 'dj song', via: 'dj' }), player.makeEntry({ asked: 'user song', explicit: true })]);
  player.current = { entry: { title: 'x', asked: 'x' }, source: null, status: 'playing' }; // pretend something is on
  script.json.push({ songs: [] });
  dj.turnOn('new mood');
  assert.deepStrictEqual(
    player.queue.items.map((e) => e.asked),
    ['user song'],
  );
  player.current = null;
  dj.turnOff();
  player.destroy();
});

test('DJ falls back to plain search when Grok fails', async () => {
  const { player, dj } = djSetup('dj5');
  script.json.push(new Error('grok down'));
  dj.turnOn('fallback mood');
  assert.ok(await waitFor(() => player.current, 6000));
  dj.turnOff();
  player.destroy();
});

test('DJ state is saved so a restart picks it back up', () => {
  const { player, dj } = djSetup('dj6');
  script.json.push({ songs: [] });
  dj.turnOn('late night');
  assert.deepStrictEqual({ enabled: store.dj('dj6').enabled, mood: store.dj('dj6').mood }, { enabled: true, mood: 'late night' });
  dj.turnOff();
  assert.strictEqual(store.dj('dj6').enabled, false);
  player.destroy();
});

test('songKey collapses decorations', () => {
  assert.strictEqual(songKey('Daft Punk - One More Time (Official Video)'), songKey('Daft Punk - One More Time [HD]'));
  assert.strictEqual(songKey('Please Come Home for Christmas (2013 Remaster)'), songKey('Please Come Home For Christmas'));
  assert.notStrictEqual(songKey('Song (Remix)'), songKey('Song'));
});

test('search returns distinct tracks by id', async () => {
  const r = await search('same title', { limit: 3 });
  assert.strictEqual(r.length, 3);
  assert.strictEqual(new Set(r.map((t) => t.key)).size, 3);
});

test('mixer output works as a Discord Opus AudioResource', async () => {
  const mixer = new Mixer();
  const resource = createAudioResource(mixer.createStream(), { inputType: StreamType.Opus, silencePaddingFrames: 0 });
  await new Promise((r) => setImmediate(r));
  const pkt = resource.read();
  assert.ok(Buffer.isBuffer(pkt) && pkt.length > 0);
});

test('TTS audio decodes to 48k stereo PCM; text cleanup', async () => {
  const pcm = await decodeToPcm(fs.readFileSync(path.join(__dirname, 'fixtures', 'tone.mp3')));
  assert.ok(pcm.length > 48000 * 4 * 5);
  assert.strictEqual(speakable('**Hi** <@123> https://x.y 🎵'), 'Hi a link');
  assert.strictEqual(speakable('Hmm. (translation: skipped it)'), 'Hmm.');
  assert.strictEqual(forText('Wow [laugh] <whisper>ok</whisper>'), 'Wow ok');
});

test('utterance WAV is 16k mono', () => {
  const pcm = Buffer.alloc(48000 * 4); // 1 s stereo
  const wav = toWav16kMono(pcm);
  assert.strictEqual(wav.readUInt32LE(24), 16000);
  assert.strictEqual(wav.readUInt16LE(22), 1);
  assert.strictEqual(wav.length, 44 + 16000 * 2);
});

test('duration parsing', () => {
  assert.strictEqual(actions.parseDuration('5m'), 300);
  assert.strictEqual(actions.parseDuration('1h30m'), 5400);
  assert.strictEqual(actions.parseDuration('90s'), 90);
  assert.strictEqual(actions.parseDuration('10'), 600);
  assert.ok(Number.isNaN(actions.parseDuration('soon')));
});

test('listener turns received Opus packets into an utterance', async () => {
  const { EventEmitter } = require('node:events');
  const { Readable } = require('node:stream');
  const { Listener } = require('../src/voice/listener');
  const { createEncoder } = require('../src/audio/opus');
  const enc = createEncoder();
  const speaking = new EventEmitter();
  let stream;
  const connection = {
    receiver: {
      speaking,
      subscribe: () => {
        stream = new Readable({ objectMode: true, read() {} });
        return stream;
      },
    },
  };
  const l = new Listener({ connection, shouldListen: () => true });
  l.start();
  let got = null;
  l.on('utterance', (u) => (got = u));
  speaking.emit('start', 'u1');
  // 1 s of a loud 300 Hz tone
  for (let f = 0; f < 50; f++) {
    const pcm = Buffer.alloc(3840);
    for (let i = 0; i < 960; i++) {
      const v = Math.round(8000 * Math.sin((2 * Math.PI * 300 * (f * 960 + i)) / 48000));
      pcm.writeInt16LE(v, i * 4);
      pcm.writeInt16LE(v, i * 4 + 2);
    }
    stream.push(enc.encode(pcm));
  }
  stream.push(null);
  assert.ok(await waitFor(() => got, 2000));
  assert.strictEqual(got.userId, 'u1');
  assert.ok(got.durationMs > 900);
  l.stop();
});
