'use strict';
// Regression tests for the failures reported in PROBLEMS.md. Each test names the problem it covers.
const { waitFor, sleep, track, pull, ytCalls, resetYtCalls, script } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { Mixer } = require('../src/audio/mixer');
const { MusicPlayer } = require('../src/music/player');
const { DJ } = require('../src/music/dj');
const sources = require('../src/music/sources');
const { classify } = sources;
const store = require('../src/store');

function setup(gid) {
  sources.reset();
  resetYtCalls();
  const mixer = new Mixer({ volume: 100 });
  const player = new MusicPlayer({ guildId: gid, mixer });
  const events = { now: [], failed: [] };
  player.on('nowPlaying', (e) => events.now.push(e));
  player.on('trackFailed', (e, r, k) => events.failed.push({ e, r, k }));
  return { mixer, player, events };
}

// ---------------------------------------------------------------- 1. no YouTube; Spotify lookup, SoundCloud audio

const { config } = require('../src/config');
const spotify = require('../src/music/spotify');
const realFetch = global.fetch;
const fakeSpotify = { tracks: {}, search: [] }; // search: [{ match: RegExp, items: [...] }]
const spTrack = (id, name, artist, sec) => ({ id, name, artists: [{ name: artist }], duration_ms: sec * 1000, external_urls: { spotify: `https://open.spotify.com/track/${id}` } });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://accounts.spotify.com/api/token')) return json({ access_token: 'tok', expires_in: 3600 });
  if (u.startsWith('https://api.spotify.com/v1/search')) {
    const q = decodeURIComponent(new URL(u).searchParams.get('q'));
    const hit = fakeSpotify.search.find((x) => x.match.test(q));
    return json({ tracks: { items: hit ? hit.items : [] } });
  }
  const tm = u.match(/api\.spotify\.com\/v1\/tracks\/(\w+)/);
  if (tm) return fakeSpotify.tracks[tm[1]] ? json(fakeSpotify.tracks[tm[1]]) : json({}, 404);
  if (/api\.spotify\.com\/v1\/playlists\//.test(u)) return json({ error: 'forbidden' }, 403);
  if (u.startsWith('https://www.youtube.com/oembed')) return json({ title: 'Tone Ytlink (Official Video)', author_name: 'ToneVEVO' });
  if (u.startsWith('https://open.spotify.com/track/')) {
    return new Response('<html><head><meta property="og:title" content="Tone Pagesong"><meta property="og:description" content="Tone Band · Album · Song · 2020"></head></html>', { status: 200 });
  }
  return realFetch(url, opts);
};
function withSpotify(on) {
  config.spotifyClientId = on ? 'id' : '';
  config.spotifyClientSecret = on ? 'secret' : '';
  spotify._reset();
}
const youtubeCalls = () => ytCalls().filter((a) => a.some((x) => /^ytsearch|youtube\.com|youtu\.be/.test(String(x))));

test('#1 YouTube is never used: a text request makes zero YouTube calls and plays SoundCloud', async () => {
  withSpotify(false);
  const { mixer, player, events } = setup('p1');
  const res = await player.request('please come home');
  assert.ok(res.ok);
  assert.ok(await waitFor(() => mixer.music?.hasData, 10000));
  await pull(mixer, 5);
  assert.ok(await waitFor(() => events.now.length === 1));
  assert.match(player.current.entry.key, /^soundcloud:/);
  assert.strictEqual(youtubeCalls().length, 0);
  player.destroy();
});

test('#1 a pasted YouTube link is only used for its title; the song plays from SoundCloud', async () => {
  withSpotify(false);
  const { mixer, player } = setup('p1b');
  const res = await player.request('https://www.youtube.com/watch?v=abc123');
  assert.ok(res.ok, res.error);
  assert.ok(await waitFor(() => mixer.music?.hasData, 10000));
  assert.match(player.current.entry.key, /^soundcloud:/);
  assert.strictEqual(youtubeCalls().length, 0, 'yt-dlp never touched YouTube');
  player.destroy();
});

test('#1 Spotify finds the real song; the SoundCloud copy plays; "now playing" uses the Spotify name', async () => {
  withSpotify(true);
  fakeSpotify.search = [{ match: /christmas/i, items: [spTrack('sp1', 'Please Come Home for Christmas - 2013 Remaster', 'Eagles', 6)] }];
  const { mixer, player, events } = setup('p1c');
  const res = await player.request('please come home for christmas');
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.entries[0].asked, 'Eagles - Please Come Home for Christmas - 2013 Remaster');
  assert.ok(await waitFor(() => mixer.music?.hasData, 10000));
  await pull(mixer, 5);
  assert.ok(await waitFor(() => events.now.length === 1));
  assert.match(events.now[0].title, /Please Come Home for Christmas/);
  assert.strictEqual(events.now[0].channel, 'Eagles');
  const scSearches = ytCalls().filter((a) => a.some((x) => /^scsearch/.test(x))).map((a) => a[a.length - 1]);
  assert.ok(scSearches.some((q) => /Eagles/.test(q)), `searched SoundCloud with the artist: ${scSearches}`);
  assert.strictEqual(youtubeCalls().length, 0);
  withSpotify(false);
  player.destroy();
});

test('#1 a Spotify track link plays from SoundCloud', async () => {
  withSpotify(true);
  fakeSpotify.tracks.sptone = spTrack('sptone', 'Tone Linksong', 'Tone Band', 6);
  const { mixer, player } = setup('p1d');
  const res = await player.request('https://open.spotify.com/track/sptone?si=xyz');
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.entries[0].meta.title, 'Tone Linksong');
  assert.ok(await waitFor(() => mixer.music?.hasData, 10000));
  assert.match(player.current.entry.key, /^soundcloud:/);
  withSpotify(false);
  player.destroy();
});

test('#1 without Spotify keys, a Spotify track link still works (public page title)', async () => {
  withSpotify(false);
  const { mixer, player } = setup('p1e');
  const res = await player.request('https://open.spotify.com/track/abcDEF123');
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.entries[0].asked, 'Tone Band - Tone Pagesong');
  assert.ok(await waitFor(() => mixer.music?.hasData, 10000));
  player.destroy();
});

test('#1 a Spotify playlist Spotify won\'t share gives a clear answer', async () => {
  withSpotify(true);
  const { player } = setup('p1f');
  const res = await player.request('https://open.spotify.com/playlist/37i9dQZF1DX0Yxoavh5qJV');
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /playlist/);
  withSpotify(false);
  player.destroy();
});

test('#1 Spotify length rejects a SoundCloud copy that is a different length (edit/preview/wrong song)', async () => {
  const { mixer, player } = setup('p1g');
  const meta = { spotifyId: 'x', title: 'Fit Song', artist: 'Tone', artists: ['Tone'], durationSec: 6, asked: 'Tone - Fit Song' };
  const wrong = { ...track('sc-wrong', 'Fit Song', 'soundcloud'), duration: 30 };
  const right = track('sc-right', 'Fit Song', 'soundcloud');
  player.enqueue([player.makeEntry({ asked: meta.asked, meta, candidates: [wrong, right], explicit: true })]);
  assert.ok(await waitFor(() => mixer.music?.hasData, 10000));
  assert.strictEqual(player.current.track.key, 'soundcloud:sc-right');
  player.destroy();
});

test('#1 classification: real reasons, and "page"/"image" no longer read as age-restricted', () => {
  assert.strictEqual(classify("ERROR: [youtube] x: Sign in to confirm you’re not a bot", 'youtube').kind, 'blocked');
  assert.strictEqual(classify('ERROR: [youtube] x: Sign in to confirm your age', 'youtube').kind, 'age');
  assert.notStrictEqual(classify('ERROR: Unable to download webpage: timed out (page)', 'soundcloud').kind, 'age');
  assert.strictEqual(classify('ERROR: [soundcloud] 1: Requested format is not available', 'soundcloud').kind, 'preview');
  assert.strictEqual(classify('ERROR: [soundcloud] 1: This video is DRM protected', 'soundcloud').kind, 'drm');
});

test('#1 a song nobody has is reported right away, not "Loading" forever', async () => {
  withSpotify(false);
  const { player } = setup('p1h');
  process.env.FAKE_SC_EMPTY = '1';
  try {
    const res = await player.request('nothing anywhere');
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /couldn't find/);
  } finally {
    delete process.env.FAKE_SC_EMPTY;
  }
  player.destroy();
});

// ---------------------------------------------------------------- 2. SoundCloud previews

test('#2 a SoundCloud preview-only copy is rejected at probe time and never played', async () => {
  const { mixer, player, events } = setup('p2');
  const e = player.makeEntry({
    asked: 'please come home for christmas',
    candidates: [track('sc-prev-1', 'Please Come Home for Christmas (2013 Remaster)', 'soundcloud'), track('sc-full-1', 'Please Come Home For Christmas', 'soundcloud')],
    explicit: true,
  });
  player.enqueue([e]);
  assert.ok(await waitFor(() => mixer.music?.hasData, 10000));
  await pull(mixer, 5);
  assert.ok(await waitFor(() => events.now.length === 1));
  assert.strictEqual(events.now[0].key, 'soundcloud:sc-full-1');
  player.destroy();
});

test('#2 a copy that stops after a few seconds is a bad copy: another copy plays, the request is not "finished"', async () => {
  const { mixer, player, events } = setup('p2b');
  let idle = 0;
  player.on('idle', () => idle++);
  const e = player.makeEntry({
    asked: 'jingle bell rock',
    candidates: [track('sc-short-1', 'Jingle Bell Rock', 'soundcloud'), track('sc-good-1', 'Jingle Bell Rock', 'soundcloud')],
    explicit: true,
  });
  player.enqueue([e]);
  // Drain the 2 s copy fully.
  for (let i = 0; i < 30 && player.current?.track?.key !== 'soundcloud:sc-good-1'; i++) {
    await pull(mixer, 20);
    await sleep(20);
  }
  assert.ok(await waitFor(() => player.current?.track?.key === 'soundcloud:sc-good-1', 8000), 'moved on to a full copy');
  assert.strictEqual(idle, 0, 'never went idle in between');
  assert.strictEqual(events.failed.length, 0);
  player.destroy();
});

test('#2 DRM copies are skipped at probe time', async () => {
  const { mixer, player } = setup('p2c');
  const e = player.makeEntry({ asked: 'x song', candidates: [track('sc-drm-1', 'x song', 'soundcloud'), track('sc-ok-2', 'x song', 'soundcloud')], explicit: true });
  player.enqueue([e]);
  assert.ok(await waitFor(() => mixer.music?.hasData, 10000));
  assert.strictEqual(player.current.track.key, 'soundcloud:sc-ok-2');
  player.destroy();
});

// ---------------------------------------------------------------- 3. skipped songs come back

test('#3 a skipped song never starts again: not as a queued duplicate, not as another upload, not from the DJ', async () => {
  const { mixer, player, events } = setup('p3');
  const dj = new DJ({ guildId: 'p3', player });
  const a = player.makeEntry({ asked: 'Eagles - Please Come Home for Christmas', candidates: [track('tone-pch', 'Eagles - Please Come Home for Christmas (Official Audio)')], explicit: true });
  const dupe = player.makeEntry({ asked: 'please come home for christmas', candidates: [track('sc-pch-2', 'Please Come Home for Christmas (2013 Remaster)', 'soundcloud')], via: 'dj' });
  const other = player.makeEntry({ asked: 'Something Else', candidates: [track('noise-other', 'Something Else')], explicit: true });
  player.enqueue([a, dupe, other]);
  assert.ok(await waitFor(() => mixer.music?.hasData, 10000));
  await pull(mixer, 5);
  player.skip();
  assert.ok(await waitFor(() => player.current?.track?.key === 'soundcloud:noise-other', 8000), 'went straight to the next different song');
  // The DJ suggests the same song again (another upload / wording): refused.
  dj.enabled = true;
  dj.mood = 'xmas';
  assert.ok(dj.rejectReason({ asked: 'Eagles - Please Come Home For Christmas' }));
  assert.ok(player._skipReason(track('sc-pch-9', 'Please Come Home for Christmas (2013 Remaster)', 'soundcloud')));
  // Nothing about it in what played.
  assert.ok(!events.now.slice(1).some((e) => /christmas/i.test(e.title)));
  dj.turnOff();
  player.destroy();
});

test('#3 skip during "finding a copy" cancels that request; its retries never come back', async () => {
  const { player, events } = setup('p3b');
  // First copy is slow to download: we skip while it is loading.
  const a = player.makeEntry({ asked: 'slow song', candidates: [track('slow-a', 'Slow Song'), track('tone-a2', 'Slow Song')], explicit: true });
  const b = player.makeEntry({ asked: 'Next One', candidates: [track('noise-b', 'Next One')], explicit: true });
  player.enqueue([a, b]);
  assert.ok(await waitFor(() => player.current?.status === 'loading'));
  player.skip();
  await sleep(4500); // past the 3 s start timeout of the skipped copy
  assert.strictEqual(player.current?.entry, b);
  assert.ok(!events.now.some((e) => e === a), 'skipped request never announced');
  assert.strictEqual(events.failed.length, 0, 'no failure report for a song that was skipped');
  player.destroy();
});

test('#3 skip memory survives a restart (new player, same guild)', async () => {
  const { mixer, player } = setup('p3c');
  player.enqueue([player.makeEntry({ asked: 'Mr. Brightside', candidates: [track('tone-mb', 'The Killers - Mr. Brightside')], explicit: true })]);
  assert.ok(await waitFor(() => mixer.music?.hasData, 10000));
  player.skip();
  player.destroy();
  await sleep(600); // store debounce
  store._cache.delete('p3c');
  const again = new MusicPlayer({ guildId: 'p3c', mixer: new Mixer() });
  assert.ok(again._skipReason(track('sc-mb', 'Mr Brightside', 'soundcloud')) || again._skipReason({ title: 'Mr. Brightside', channel: 'The Killers' }));
  again.destroy();
});

test('#3 asking for a skipped song again on purpose plays it', async () => {
  const { mixer, player, events } = setup('p3d');
  await player.request('tone again');
  assert.ok(await waitFor(() => mixer.music?.hasData, 10000));
  await pull(mixer, 3);
  player.skip();
  assert.ok(player._skipReason({ title: 'tone again #0', channel: 'Fake' }));
  await player.request('tone again');
  assert.ok(await waitFor(() => mixer.music?.hasData && player.current?.status !== 'resolving', 10000));
  await pull(mixer, 3);
  assert.ok(await waitFor(() => events.now.length === 2));
  player.destroy();
});

test('#3 a mid-song cut resumes the SAME request, but never after it was skipped', async () => {
  const { mixer, player, events } = setup('p3e');
  process.env.FAKE_DURATION = '60'; // catalog says 60 s, the file is 6 s: looks like a cut-off stream
  try {
    player.enqueue([player.makeEntry({ asked: 'Cut Song', candidates: [track('tone-cut', 'Cut Song')], explicit: true })]);
    assert.ok(await waitFor(() => mixer.music?.hasData, 10000));
    player.skip();
    for (let i = 0; i < 20; i++) await pull(mixer, 20);
    await sleep(300);
    assert.ok(!player.current || player.current.entry.asked !== 'Cut Song', 'a skipped song was resumed');
    assert.strictEqual(events.now.length, 0);
  } finally {
    delete process.env.FAKE_DURATION;
  }
  player.destroy();
});

test('#3 DJ refill during a start never starts a second song', async () => {
  const { mixer, player } = setup('p3f');
  const dj = new DJ({ guildId: 'p3f', player });
  script.json.push({ songs: [{ artist: 'Tone', title: 'Alpha' }, { artist: 'Tone', title: 'Beta' }, { artist: 'Tone', title: 'Gamma' }] });
  let starts = 0;
  const orig = player._play.bind(player);
  player._play = (...a) => {
    if (!a[2]) starts++;
    return orig(...a);
  };
  dj.turnOn('test');
  assert.ok(await waitFor(() => mixer.music?.hasData, 10000));
  await sleep(500);
  assert.strictEqual(starts, 1, `expected one start, got ${starts}`);
  dj.turnOff();
  player.destroy();
});

test('#3 identity: same song across sources, different songs stay different', () => {
  const { sameSong } = require('../src/music/identity');
  assert.ok(sameSong({ title: 'Eagles - Please Come Home for Christmas (Official Audio)', channel: 'EaglesVEVO' }, { title: 'Please Come Home for Christmas (2013 Remaster)', channel: 'Eagles' }));
  assert.ok(sameSong('Fleetwood Mac - Dreams', { title: 'Dreams', channel: 'Fleetwood Mac' }));
  assert.ok(!sameSong('Fleetwood Mac - Dreams', { title: 'Sweet Dreams (Are Made of This)', channel: 'Eurythmics' }));
  assert.ok(!sameSong({ title: 'Jingle Bell Rock', channel: 'Bobby Helms' }, { title: 'Jingle Bell Rock (Remix)', channel: 'DJ' }));
  assert.ok(!sameSong({ title: 'Mr. Brightside', channel: 'The Killers' }, { title: 'Somebody Told Me', channel: 'The Killers' }));
});

// ---------------------------------------------------------------- tooling

test('missing yt-dlp is reported once as a setup problem, not walked through every upload', async () => {
  const prev = process.env.YTDLP_PATH;
  const { config } = require('../src/config');
  const before = config.ytdlpPath;
  config.ytdlpPath = '/nonexistent/yt-dlp';
  const { player, events } = setup('p-tool');
  const e = player.makeEntry({ asked: 'x', candidates: [track('tone-x1', 'x'), track('tone-x2', 'x')], explicit: true });
  player.enqueue([e]);
  assert.ok(await waitFor(() => events.failed.length === 1, 8000));
  assert.match(events.failed[0].r, /not installed/);
  config.ytdlpPath = before;
  process.env.YTDLP_PATH = prev;
  player.destroy();
});
