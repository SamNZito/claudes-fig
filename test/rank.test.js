'use strict';
// Originals before user-made versions, unless the request asks for that version.
const { waitFor, pull } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { Mixer } = require('../src/audio/mixer');
const { MusicPlayer } = require('../src/music/player');
const sources = require('../src/music/sources');
const { rankCandidate, unaskedVersions, ownUpload } = require('../src/music/rank');

const RESULTS = [
  { title: 'let go - ark patrol (jersey club + brazil funk remix) @prod.tjthesaint', channel: 'tjthesaint' },
  { title: 'Let Go (sped up)', channel: 'nightcorez' },
  { title: 'Let Go', channel: 'Ark Patrol' },
];

async function firstPlayed(gid, ask) {
  sources.reset();
  process.env.FAKE_SC_RESULTS = JSON.stringify(RESULTS);
  const mixer = new Mixer({ volume: 100 });
  const player = new MusicPlayer({ guildId: gid, mixer });
  const now = [];
  player.on('nowPlaying', (e) => now.push(e));
  try {
    const res = await player.request(ask);
    assert.ok(res.ok, res.error);
    assert.ok(await waitFor(() => mixer.music?.hasData, 10000));
    await pull(mixer, 5);
    assert.ok(await waitFor(() => now.length === 1));
    return now[0];
  } finally {
    delete process.env.FAKE_SC_RESULTS;
    player.destroy();
  }
}

test('the original by the artist plays, not the remix that came first in the search', async () => {
  const e = await firstPlayed('rank1', 'ark patrol let go');
  assert.match(e.key, /-2$/, `played ${e.copyTitle}`);
  assert.equal(e.copyTitle, 'Let Go');
});

test('asking for the remix gets the remix', async () => {
  const e = await firstPlayed('rank2', 'let go ark patrol jersey club remix');
  assert.match(e.key, /-0$/, `played ${e.copyTitle}`);
});

test('version markers: only the ones nobody asked for count; "radio edit" is the original', () => {
  assert.deepEqual(unaskedVersions('Let Go (Phantom Remix)', 'ark patrol let go phantom remix'), []);
  assert.deepEqual(unaskedVersions('Song (Sped Up + Reverb)', 'song'), ['sped up', 'slowed']);
  assert.deepEqual(unaskedVersions('Song - Radio Edit', 'song'), []);
  assert.deepEqual(unaskedVersions('Cover Me Up', 'cover me up'), []);
  assert.deepEqual(unaskedVersions('Song (Nightcore)', 'song'), ['nightcore']);
});

test("the artist's own account gets a bonus; strangers don't", () => {
  assert.equal(ownUpload({ channel: 'Mariah Carey' }, { asked: 'mariah carey all i want for christmas is you' }), true);
  assert.equal(ownUpload({ channel: 'mariahcareyofficial' }, { artist: 'Mariah Carey', asked: 'x' }), true);
  assert.equal(ownUpload({ channel: 'xmas remix guy' }, { artist: 'Mariah Carey', asked: 'all i want for christmas' }), false);
  assert.equal(ownUpload({ channel: '' }, { asked: 'anything' }), false);
  const own = rankCandidate({ title: 'All I Want For Christmas Is You', channel: 'Mariah Carey' }, { match: 0.8, asked: 'mariah carey all i want for christmas is you' });
  const remix = rankCandidate({ title: 'All I Want For Christmas Is You (Remix)', channel: 'dj x' }, { match: 0.9, asked: 'mariah carey all i want for christmas is you' });
  assert.ok(own.score > remix.score);
});
