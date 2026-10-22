'use strict';
// "Where is this song coming from?" links: only real web pages, named by site.
const test = require('node:test');
const assert = require('node:assert');
const { sourceLinks, chatLinks } = require('../src/music/links');

test('the playing page and the Spotify match, as safe links', () => {
  const e = { pageUrl: 'https://soundcloud.com/vince/o-tannenbaum', url: 'https://api-v2.soundcloud.com/tracks/1', meta: { url: 'https://open.spotify.com/track/abc' } };
  assert.deepEqual(sourceLinks(e), { playing: { site: 'SoundCloud', url: 'https://soundcloud.com/vince/o-tannenbaum' }, spotify: 'https://open.spotify.com/track/abc' });
  assert.equal(chatLinks(e), ' · [SoundCloud](<https://soundcloud.com/vince/o-tannenbaum>) · [Spotify match](<https://open.spotify.com/track/abc>)');
});

test('API addresses, odd schemes and missing links are left out', () => {
  assert.deepEqual(sourceLinks({ url: 'https://api-v2.soundcloud.com/tracks/1' }), { playing: null, spotify: null });
  assert.deepEqual(sourceLinks({ pageUrl: 'javascript:alert(1)', meta: { url: 'https://evil.example/x' } }), { playing: null, spotify: null });
  assert.equal(chatLinks({}), '');
  assert.equal(chatLinks({ pageUrl: 'https://soundcloud.com/a/b' }), ' · [SoundCloud](<https://soundcloud.com/a/b>)');
});
