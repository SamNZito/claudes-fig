'use strict';
// Preview-only song -> Fig offers the closest full version; "Fig, play that" plays it.
const { script, fakeGuild, fakeMember, waitFor } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { GuildSession } = require('../src/voice/session');
const sources = require('../src/music/sources');
const { songTitle } = require('../src/music/alternatives');

test("the song's name, without the artist", () => {
  assert.equal(songTitle({ meta: { title: 'O Tannenbaum (Remastered)' } }), 'O Tannenbaum');
  assert.equal(songTitle({ asked: 'vince guaraldi trio o tannenbaum', candidates: [{ title: 'Vince Guaraldi Trio - O Tannenbaum', rank: 1 }] }), 'O Tannenbaum');
  assert.equal(songTitle({ asked: 'Eagles - Please Come Home for Christmas' }), 'Please Come Home for Christmas');
});

function session(gid) {
  sources.reset();
  const guild = fakeGuild(gid);
  const sam = fakeMember(guild, 'sam', 'Sam', { admin: true });
  const s = new GuildSession({}, guild);
  s.connection = { state: { status: 'ready' }, destroy() {} };
  const posted = [];
  s.postText = (t) => posted.push(t);
  s.speak = async () => true;
  return { s, sam, posted };
}

test('preview-only original -> the closest full version is offered, and "Fig, play that" plays it', async () => {
  process.env.FAKE_DURATION = '120'; // full-length copies
  process.env.FAKE_SC_RESULTS = JSON.stringify({
    vince: [
      { id: 'prev-orig-1', title: 'Vince Guaraldi Trio - O Tannenbaum', channel: 'Vince Guaraldi Trio' },
      { id: 'prev-orig-2', title: 'O Tannenbaum', channel: 'Vince Guaraldi Trio' },
    ],
    '*': [
      { id: 'prev-orig-3', title: 'O Tannenbaum', channel: 'label' },
      { id: 'other-song', title: 'Linus and Lucy', channel: 'someone' },
      { id: 'alt-piano', title: 'O Tannenbaum (piano cover)', channel: 'keys guy' },
    ],
  });
  const { s, sam, posted } = session('alt1');
  try {
    const res = await s.player.request('vince guaraldi trio o tannenbaum', { requestedBy: { id: sam.id, name: 'Sam' } });
    assert.ok(res.ok, res.error);
    assert.ok(await waitFor(() => posted.some((p) => p.startsWith('Closest full version')), 20000), posted.join('\n'));
    assert.ok(posted.some((p) => /^Couldn't play .*previews or locked copies/.test(p)));
    const offer = posted.find((p) => p.startsWith('Closest full version'));
    assert.match(offer, /^Closest full version of \*\*O Tannenbaum\*\*: \*\*O Tannenbaum \(piano cover\)\*\* by keys guy \(2:00\) · \[SoundCloud\]\(<https:\/\/soundcloud\.com\/fake\/alt-piano>\)\. Say "Fig, play that" or type `\/play that`\./);
    assert.equal(s.pendingOffer.url, 'https://soundcloud.com/fake/alt-piano');

    // "Fig, play that" -> that exact upload
    script.stt.push('fig play that');
    await s.brain._utterance({ userId: 'sam', wav: Buffer.alloc(100), durationMs: 800 });
    assert.ok(await waitFor(() => s.player.current?.entry?.key === 'soundcloud:alt-piano' || s.player.queue.items.some((e) => e.pinned === 'soundcloud:alt-piano'), 10000));
    assert.equal(s.pendingOffer, null, 'an offer is used once');
  } finally {
    delete process.env.FAKE_DURATION;
    delete process.env.FAKE_SC_RESULTS;
    s.connection = null;
    s.destroy();
  }
});

test('/play that with nothing offered says so; "play that" by voice without an offer goes to Grok', async () => {
  const { s, sam } = session('alt2');
  const actions = require('../src/actions');
  const r = await actions.play(s.ctx(sam, 'slash'), { query: 'that' });
  assert.equal(r.ok, false);
  assert.match(r.say || r.text, /don't have another version lined up/);
  const before = script.calls.length;
  script.chat.push({ content: 'Play what?', toolCalls: [] });
  script.stt.push('fig play that');
  await s.brain._utterance({ userId: 'sam', wav: Buffer.alloc(100), durationMs: 800 });
  assert.equal(script.calls.length, before + 1, 'went to Grok');
  s.connection = null;
  s.destroy();
});
