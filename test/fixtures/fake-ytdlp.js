#!/usr/bin/env node
'use strict';
// Stand-in for yt-dlp in tests. Behaviour is chosen by words inside the track id:
//   YouTube ids:    "bot"  -> bot check (host refused)      "age" -> age-restricted
//   SoundCloud ids: "prev" -> only a 30 s preview exists     "drm" -> DRM
//   any:            "bad"  -> unavailable    "short" -> probe says 200 s but the stream is 2 s
//                   "dlfail" -> probe ok, download 403       "slow" -> download hangs
//                   "noise" -> noise.mp3, otherwise tone.mp3 (6 s)
// Search: ytsearchN:q -> ids "<slug>-<i>";  scsearchN:q -> ids "sc-<slug>-<i>".
// Every call is appended to $FAKE_YTDLP_LOG (if set) so tests can count probes.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const last = args[args.length - 1] || '';
if (args[0] === '--version') {
  console.log('2026.09.30');
  process.exit(0);
}
if (process.env.FAKE_YTDLP_LOG) fs.appendFileSync(process.env.FAKE_YTDLP_LOG, `${JSON.stringify(args)}\n`);

function idFromUrl(u) {
  const yt = String(u).match(/v=([^&]+)/);
  if (yt) return { id: yt[1], source: 'youtube' };
  const sc = String(u).match(/soundcloud\.com\/fake\/([^/?]+)/);
  if (sc) return { id: sc[1], source: 'soundcloud' };
  return { id: 'x', source: 'youtube' };
}

function info(id, source) {
  const duration = /short/.test(id) ? 200 : Number(process.env.FAKE_DURATION || 6);
  return {
    id,
    title: process.env[`FAKE_TITLE_${id}`] || `Video ${id}`,
    duration,
    channel: 'Fake',
    extractor_key: source === 'soundcloud' ? 'Soundcloud' : 'Youtube',
    webpage_url: source === 'soundcloud' ? `https://soundcloud.com/fake/${id}` : `https://www.youtube.com/watch?v=${id}`,
    format_id: source === 'soundcloud' ? 'http_mp3_128' : '251',
  };
}

function refuse(id, source) {
  if (source === 'youtube' && /bot/.test(id)) return "ERROR: [youtube] bot: Sign in to confirm you're not a bot. Use --cookies-from-browser";
  if (source === 'youtube' && /age/.test(id)) return 'ERROR: [youtube] age: Sign in to confirm your age. This video may be inappropriate for some users.';
  if (/bad/.test(id)) return `ERROR: [${source}] ${id}: Video unavailable`;
  if (source === 'soundcloud' && /prev/.test(id)) return `ERROR: [soundcloud] ${id}: Requested format is not available. Use --list-formats for a list of available formats`;
  if (source === 'soundcloud' && /drm/.test(id)) return `ERROR: [soundcloud] ${id}: This video is DRM protected`;
  return null;
}

// ---- search ----
if (args.includes('--dump-json')) {
  const m = last.match(/^(yt|sc)search(\d+):(.*)$/);
  if (m) {
    const q = m[3].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const n = Number(m[2]);
    const sc = m[1] === 'sc';
    if (sc && process.env.FAKE_SC_EMPTY) process.exit(0);
    for (let i = 0; i < n; i++) {
      const id = sc ? `sc-${q}-${i}` : `${q}-${i}`;
      const src = sc ? 'soundcloud' : 'youtube';
      const it = info(id, src);
      console.log(
        JSON.stringify({
          id,
          title: `${m[3].trim()} #${i}`,
          duration: Number(process.env.FAKE_DURATION || 6),
          channel: 'Fake',
          ie_key: sc ? 'Soundcloud' : 'Youtube',
          url: it.webpage_url,
        }),
      );
    }
    process.exit(0);
  }
  const { id, source } = idFromUrl(last);
  console.log(JSON.stringify(info(id, source)));
  process.exit(0);
}

// ---- probe ----
if (args.includes('-J')) {
  const { id, source } = idFromUrl(last);
  const why = refuse(id, source);
  if (why) {
    process.stderr.write(`${why}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(info(id, source))}\n`);
  process.exit(0);
}

// ---- download ----
let id;
let source;
const li = args.indexOf('--load-info-json');
if (li >= 0) {
  const data = JSON.parse(fs.readFileSync(args[li + 1], 'utf8'));
  id = data.id;
  source = /soundcloud/i.test(data.extractor_key) ? 'soundcloud' : 'youtube';
} else ({ id, source } = idFromUrl(last));

const why = refuse(id, source);
if (why) {
  process.stderr.write(`${why}\n`);
  process.exit(1);
}
if (/dlfail/.test(id)) {
  process.stderr.write('ERROR: unable to download video data: HTTP Error 403: Forbidden\n');
  process.exit(1);
}
if (/slow/.test(id)) {
  setInterval(() => {}, 1000);
} else {
  const file = path.join(__dirname, /short/.test(id) ? 'short.mp3' : /noise/.test(id) ? 'noise.mp3' : 'tone.mp3');
  const ds = args.indexOf('--download-sections');
  const start = ds >= 0 ? Number((args[ds + 1].match(/\*(\d+)/) || [])[1] || 0) : 0;
  if (start > 0) {
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-ss', String(start), '-i', file, '-f', 'mp3', 'pipe:1']);
    ff.stdout.pipe(process.stdout);
  } else fs.createReadStream(file).pipe(process.stdout);
}
