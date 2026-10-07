'use strict';
// `npm run doctor` - checks everything Fig needs before you start it, and says how to fix what's missing.
// Optional: `npm run doctor -- "song name"` also tries downloading a few seconds of that song.
const { spawnSync } = require('node:child_process');
const { config, validateConfig } = require('../src/config');
const { ffmpegPath, ytdlpSpawn } = require('../src/audio/binaries');

let failed = 0;
const okMark = (m) => console.log(`  OK    ${m}`);
const bad = (m, fix) => {
  failed++;
  console.log(`  FAIL  ${m}${fix ? `\n        fix: ${fix}` : ''}`);
};
const warn = (m, fix) => console.log(`  WARN  ${m}${fix ? `\n        tip: ${fix}` : ''}`);

function version(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (r.status === 0) return (r.stdout || r.stderr).split(/\r?\n/)[0].trim();
  } catch {
    /* ignore */
  }
  return null;
}

async function main() {
  console.log('Fig doctor\n');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 12)) okMark(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node} is too old`, 'install Node 22.12+ (winget install OpenJS.NodeJS.LTS)');

  for (const p of validateConfig()) bad(p, 'copy .env.example to .env and fill it in');
  if (!validateConfig().length) okMark('.env has DISCORD_TOKEN and XAI_API_KEY');

  const ff = ffmpegPath();
  const ffv = version(ff, ['-version']);
  if (ffv) okMark(`ffmpeg: ${ffv.slice(0, 60)}`);
  else bad('ffmpeg not found', 'winget install Gyan.FFmpeg   (or set FFMPEG_PATH in .env)');

  const ytv = version(...ytdlpSpawn(['--version']));
  if (ytv) {
    okMark(`yt-dlp ${ytv}`);
    const age = (Date.now() - Date.parse(ytv.replace(/\./g, '-').slice(0, 10))) / 86400000;
    if (age > 45) warn(`yt-dlp is ${Math.round(age)} days old; YouTube breaks old versions`, 'yt-dlp -U   (or winget upgrade yt-dlp.yt-dlp)');
  } else bad('yt-dlp not found', 'winget install yt-dlp.yt-dlp   (or set YTDLP_PATH in .env)');


  try {
    require('opusscript');
    okMark('opus encoder (opusscript)');
  } catch {
    bad('opusscript missing', 'npm install');
  }
  try {
    require('@snazzah/davey');
    okMark('DAVE end-to-end encryption library');
  } catch (e) {
    bad(`@snazzah/davey failed to load (${e.message})`, 'npm install  (Discord requires DAVE for voice)');
  }

  if (config.xaiKey) {
    try {
      const res = await fetch(`${config.xaiBase}/models`, { headers: { Authorization: `Bearer ${config.xaiKey}` }, signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const data = await res.json();
        const ids = (data.data || []).map((m) => m.id);
        okMark(`xAI key works (${ids.length} models)`);
        if (ids.length && !ids.includes(config.grokModel)) warn(`GROK_MODEL "${config.grokModel}" not in your model list`, `pick one of: ${ids.slice(0, 8).join(', ')}`);
      } else bad(`xAI API returned ${res.status}`, 'check XAI_API_KEY at console.x.ai');
    } catch (e) {
      bad(`could not reach xAI: ${e.message}`);
    }
  }

  // Spotify (optional): exact song lookup + Spotify links.
  const spotify = require('../src/music/spotify');
  if (spotify.configured()) {
    try {
      const r = await spotify.searchTracks('daft punk one more time', { limit: 1 });
      if (r.length) okMark(`Spotify lookup works ("${r[0].asked}", ${r[0].durationSec}s)`);
      else warn('Spotify answered but found nothing for a test search');
    } catch (e) {
      bad(`Spotify: ${e.message}`, 'check SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET (developer.spotify.com; the app owner needs Premium since Feb 2026)');
    }
  } else warn('Spotify keys not set (optional)', 'add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET for exact song matching and Spotify album links');

  const song = process.argv[2];
  if (song && ytv && ffv) {
    // Same path Fig uses: look the song up, find a full SoundCloud copy (no previews/DRM), download a few seconds.
    const { lookup } = require('../src/music/lookup');
    const { findPlayable } = require('../src/music/resolve');
    console.log(`\nLooking up "${song}"...`);
    const found = await lookup(song);
    if (!found.ok) bad(`lookup failed: ${found.error}`);
    else {
      const it = found.items[0];
      okMark(`found "${it.asked}"${it.meta?.durationSec ? ` (${it.meta.durationSec}s, via Spotify)` : ' (via SoundCloud search)'}`);
      const req = { asked: it.asked, meta: it.meta || null, candidates: it.candidates || [], pinned: it.pinned || null, typed: it.typed || null, tried: new Set() };
      const res = await findPlayable(req);
      if (!res.ok) bad(`no playable copy: ${res.reason}`, 'many major-label songs are only previews or DRM on SoundCloud; try another song to confirm the setup works');
      else {
        okMark(`SoundCloud copy: "${res.track.title}" ${Math.round(res.probe.duration)}s`);
        const { TrackSource } = require('../src/audio/trackSource');
        const ok = await new Promise((resolve) => {
          const t = new TrackSource(res.track, { infoPath: res.probe.infoPath }).start();
          const timer = setTimeout(() => {
            t.destroy();
            resolve('no audio within 45s');
          }, 45000);
          t.on('ready', () => {
            clearTimeout(timer);
            t.destroy();
            resolve(true);
          });
          t.on('failed', (r) => {
            clearTimeout(timer);
            resolve(r);
          });
        });
        if (ok === true) okMark('music download + decode works');
        else bad(`music download failed: ${ok}`, 'update yt-dlp (yt-dlp -U)');
      }
    }
  } else if (!song) console.log('\n(Tip: `npm run doctor -- "song name"` also tests finding and downloading a real song.)');

  console.log(failed ? `\n${failed} problem(s) to fix.` : '\nAll good. Start Fig with: npm start');
  process.exit(failed ? 1 : 0);
}

main();
