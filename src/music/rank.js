'use strict';
// Which upload to try first. SoundCloud search mixes the original with user-made versions (remixes,
// sped up, nightcore, jersey club...). Those used to rank the same as the original, because only the
// words and the length were compared. Now:
//   - a version marker the request didn't ask for costs points (asking for "let go remix" is fine)
//   - an upload from the artist's own account gets a small bonus
// Nothing is thrown away here: a remix can still play if it's the only full copy.
const { tokens } = require('./identity');

// [label, pattern]. Checked against the upload's title; skipped when the request mentions it too.
const VERSIONS = [
  ['remix', /\bremix(es|ed)?\b|\brmx\b|\brework\b|\bre-?edit\b/],
  ['sped up', /\bsped[\s-]?up\b|\bspeed[\s-]?up\b|\bspedup\b/],
  ['slowed', /\bslowed\b|\breverb\b/],
  ['nightcore', /\bnightcore\b/],
  ['cover', /\bcover(ed)?\b/],
  ['jersey club', /\bjersey(\s+club)?\b/],
  ['bootleg', /\bbootleg\b|\bflip\b|\bvip\b/],
  ['mashup', /\bmash[\s-]?up\b/],
  ['edit', /\bedit\b/], // "radio edit" is removed before this check
  ['type beat', /\btype\s+beat\b/],
  ['8d', /\b8d\b/],
  ['bass boosted', /\bbass[\s-]?boost(ed)?\b/],
  ['karaoke', /\bkaraoke\b|\binstrumental\b|\bacapella\b|\ba cappella\b/],
  ['live', /\blive\b/],
  ['loop', /\b(1|one|10|ten)\s*hours?\b|\blooped\b/],
  ['phonk', /\bphonk\b/],
];

const VERSION_PENALTY = 0.35;
const OWN_UPLOAD_BONUS = 0.15;

/** Version markers in `title` that `asked` doesn't mention. */
function unaskedVersions(title, asked) {
  const t = String(title || '')
    .toLowerCase()
    .replace(/\bradio\s+edit\b/g, ' ');
  const a = String(asked || '').toLowerCase();
  return VERSIONS.filter(([, re]) => re.test(t) && !re.test(a)).map(([label]) => label);
}

/** Is this the artist's own account? Its name is the artist, or entirely part of what was asked. */
function ownUpload(track, { artist, asked }) {
  const ch = tokens(track?.channel || '');
  if (!ch.size) return false;
  const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (artist && compact(track.channel) && (compact(track.channel) === compact(artist) || compact(track.channel) === `${compact(artist)}official`)) return true;
  const ask = tokens(`${artist || ''} ${asked || ''}`);
  for (const w of ch) if (!ask.has(w)) return false;
  return true;
}

/**
 * Score one candidate. `match` is how well its words fit the request (0..1, from identity.matchesAsk).
 * @returns {{score:number, why:string[]}}
 */
function rankCandidate(track, { match, asked, artist }) {
  let score = match;
  const why = [`words ${match.toFixed(2)}`];
  const extra = unaskedVersions(track?.title, asked);
  if (extra.length) {
    score -= VERSION_PENALTY * Math.min(2, extra.length);
    why.push(`${extra.join(' + ')} (not asked for)`);
  }
  if (ownUpload(track, { artist, asked })) {
    score += OWN_UPLOAD_BONUS;
    why.push("artist's own upload");
  }
  return { score, why };
}

module.exports = { rankCandidate, unaskedVersions, ownUpload, VERSIONS };
