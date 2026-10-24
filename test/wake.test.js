'use strict';
// Fig answers when it's spoken TO, not when it's mentioned.
const test = require('node:test');
const assert = require('node:assert');
const { detectWake } = require('../src/brain/wake');

const FOR_FIG = [
  ['Hey Fig, play Mr. Brightside.', 'play mr brightside'],
  ['fig skip', 'skip'],
  ['Okay Fig', ''],
  ['Hey, Fig, can you play something that reminds me of being in a movie?', 'can you play something that reminds me of being in a movie'],
  ['Fig can you skip this', 'can you skip this'],
  ['Fig, is it raining?', 'is it raining'],
  ['can you skip this song, Fig?', 'can you skip this song'],
  ["What's up Fig?", "what's up"],
  ['skip this fig', 'skip this'],
  ['That song sucks. Fig, skip it.', 'skip it'],
  ['yo fig turn it down', 'turn it down'],
  ['Fig. Pause.', 'pause'],
];
const NOT_FOR_FIG = [
  'I think fig is broken again.',
  'Fig is so dumb.',
  "Fig's playing the wrong song.",
  'Fig keeps cutting out.',
  'Did fig just say that?',
  'I love fig jam on toast.',
  'We should ask Fig later about it.',
  'Fig and I are best friends.',
  "Yeah, whoa, that's the only state fuckin' he knows.",
];

test('spoken to Fig: counts, and the words for Fig are the right ones', () => {
  for (const [said, rest] of FOR_FIG) {
    const r = detectWake(said, 'Fig');
    assert.equal(r.named, true, said);
    assert.equal(r.text, rest, said);
  }
});

test('mentioned or talked about: does not count', () => {
  for (const said of NOT_FOR_FIG) assert.equal(detectWake(said, 'Fig').named, false, said);
  assert.equal(detectWake('I think fig is broken again.', 'Fig').mentioned, true);
});
