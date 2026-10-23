'use strict';
// SoundCloud says which uploads are preview-only / locked, so Fig skips them without probing.
process.env.SOUNDCLOUD_CHECK = 'on'; // before helpers, which turns it off for every other test
const { waitFor, pull, ytCalls, resetYtCalls } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { Mixer } = require('../src/audio/mixer');
const { MusicPlayer } = require('../src/music/player');
const sources = require('../src/music/sources');
const scinfo = require('../src/music/scinfo');

// ---- fake soundcloud.com + api-v2 ----
const CID = 'abcdefghijklmnopqrstuvwxyz123456';
const api = { tracks: {}, status: 200, rejectFirstWith: 0, calls: 0, idCalls: 0 };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u === 'https://soundcloud.com/') {
    api.idCalls++;
    return new Response('<html><script crossorigin src="https://a-v2.sndcdn.com/assets/0-abc.js"></script><script crossorigin src="https://a-v2.sndcdn.com/assets/49-app.js"></script></html>');
  }
  if (u.endsWith('49-app.js')) return new Response(`foo({client_id:"${CID}",env:"production"})`);
  if (u.endsWith('0-abc.js')) return new Response('nothing here');
  if (u.startsWith('https://api-v2.soundcloud.com/tracks?')) {
    api.calls++;
    if (api.rejectFirstWith) {
      const s = api.rejectFirstWith;
      api.rejectFirstWith = 0;
      return json({}, s);
    }
    if (api.status !== 200) return json({}, api.status);
    const p = new URL(u).searchParams;
    assert.equal(p.get('client_id'), CID);
    return json(p.get('ids').split(',').map((id) => api.tracks[id]).filter(Boolean));
  }
  return realFetch(url, opts);
};

const track = (id, { policy = 'ALLOW', protocols = ['progressive', 'hls'], snipped = false, artist = '', verified = false } = {}) => ({
  id: Number(id),
  policy,
  duration: 6000,
  full_duration: 6000,
  media: { transcodings: protocols.map((p) => ({ format: { protocol: p }, snipped })) },
  publisher_metadata: artist ? { artist, isrc: 'USABC1234567' } : {},
  user: { username: 'someone', verified },
});

async function play(gid, ask, results) {
  sources.reset();
  scinfo._reset();
  resetYtCalls();
  process.env.FAKE_SC_RESULTS = JSON.stringify(results);
  const mixer = new Mixer({ volume: 100 });
  const player = new MusicPlayer({ guildId: gid, mixer });
  const now = [];
  const failed = [];
  player.on('nowPlaying', (e) => now.push(e));
  player.on('trackFailed', (e, r) => failed.push(r));
  try {
    const res = await player.request(ask);
    assert.ok(res.ok, res.error);
    // "Now playing" fires only once audio is actually pulled out of the mixer.
    await waitFor(() => failed.length || mixer.music?.hasData, 15000);
    if (mixer.music?.hasData) {
      await pull(mixer, 5);
      await waitFor(() => now.length, 5000);
    }
    const probed = ytCalls().filter((a) => a.includes('-J')).map((a) => a[a.length - 1]);
    return { now, failed, probed };
  } finally {
    delete process.env.FAKE_SC_RESULTS;
    player.destroy();
  }
}

test('what counts as playable', () => {
  const v = (t) => scinfo.verdict(scinfo.summarize(t));
  assert.equal(v(track(1)).playable, true);
  assert.deepEqual(v(track(1, { policy: 'SNIP' })), { playable: false, kind: 'preview', reason: 'SoundCloud only offers a 30-second preview of it' });
  assert.equal(v(track(1, { snipped: true })).kind, 'preview');
  assert.equal(v(track(1, { protocols: ['ctr-encrypted-hls', 'cbc-encrypted-hls'] })).kind, 'drm');
  assert.equal(v(track(1, { policy: 'BLOCK' })).kind, 'blocked');
  assert.equal(scinfo.official(scinfo.summarize(track(1, { artist: 'Vince Guaraldi Trio' }))), true);
  assert.equal(scinfo.official(scinfo.summarize(track(1))), false);
});

test('a preview-only official copy is skipped without a probe; the full copy plays', async () => {
  api.tracks = { 111: track(111, { policy: 'SNIP', artist: 'Vince Guaraldi Trio' }), 222: track(222) };
  const r = await play('sc1', 'vince guaraldi trio o tannenbaum', [
    { id: '111', title: 'O Tannenbaum', channel: 'Vince Guaraldi Trio' },
    { id: '222', title: 'O Tannenbaum', channel: 'jazz piano covers' },
  ]);
  assert.equal(r.now[0]?.key, 'soundcloud:222');
  assert.ok(!r.probed.some((u) => u.includes('/111')), `111 was probed: ${r.probed}`);
});

test('every copy locked: the exact reason, and no probes at all', async () => {
  api.tracks = { 333: track(333, { policy: 'SNIP' }), 444: track(444, { protocols: ['ctr-encrypted-hls'] }) };
  const r = await play('sc2', 'mariah carey all i want for christmas', [
    { id: '333', title: 'All I Want for Christmas Is You', channel: 'Mariah Carey' },
    { id: '444', title: 'All I Want for Christmas Is You', channel: 'Mariah Carey' },
  ]);
  assert.equal(r.now.length, 0);
  assert.match(r.failed[0], /SoundCloud only has previews or locked copies/);
  assert.deepEqual(r.probed, []);
});

test('an official upload is preferred over a stranger with the same title', async () => {
  api.tracks = { 555: track(555), 666: track(666, { artist: 'Band', verified: true }) };
  const r = await play('sc3', 'song title', [
    { id: '555', title: 'Song Title', channel: 'random' },
    { id: '666', title: 'Song Title', channel: 'label uploads' },
  ]);
  assert.equal(r.now[0]?.key, 'soundcloud:666');
});

test('a rotated client_id is fetched again; an API outage just means probing as before', async () => {
  api.tracks = { 777: track(777, { policy: 'SNIP' }), 888: track(888) };
  api.rejectFirstWith = 401;
  const before = api.idCalls;
  let r = await play('sc4', 'x song', [
    { id: '777', title: 'X Song', channel: 'x' },
    { id: '888', title: 'X Song', channel: 'y' },
  ]);
  assert.equal(r.now[0]?.key, 'soundcloud:888');
  assert.ok(api.idCalls > before, 'read a fresh client_id');

  api.status = 500;
  r = await play('sc5', 'y song', [{ id: '999', title: 'Y Song', channel: 'y' }]);
  api.status = 200;
  assert.equal(r.now[0]?.key, 'soundcloud:999', 'still plays when the check fails');
  assert.ok(r.probed.some((u) => u.includes('/999')));
});
