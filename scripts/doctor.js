'use strict';
// `npm run doctor` - checks everything Fig needs before you start it, and says how to fix what's missing.
// Optional: `npm run doctor -- "song name"` also tries downloading a few seconds of that song.
const { spawnSync, spawn } = require('node:child_process');
const { config, validateConfig } = require('../src/config');
const { ffmpegPath, ytdlpSpawn, ytdlpBaseArgs, AUDIO_FORMAT } = require('../src/audio/binaries');

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

  if (version('deno', ['--version'])) okMark('deno (JavaScript runtime yt-dlp uses for YouTube)');
  else warn('deno not found; recent yt-dlp needs a JS runtime for YouTube', 'winget install DenoLand.Deno');

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

  const song = process.argv[2];
  if (song && ytv && ffv) {
    console.log(`\nTrying to download a few seconds of "${song}"...`);
    const ok = await new Promise((resolve) => {
      const yt = spawn(...ytdlpSpawn([...ytdlpBaseArgs(), '--no-playlist', '-f', AUDIO_FORMAT, '-o', '-', `ytsearch1:${song}`]), { windowsHide: true });
      const f = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-t', '5', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], { windowsHide: true });
      let bytes = 0;
      let err = '';
      yt.stdout.pipe(f.stdin);
      f.stdin.on('error', () => {});
      yt.stderr.on('data', (d) => (err += d));
      f.stdout.on('data', (d) => (bytes += d.length));
      f.on('close', () => {
        yt.kill();
        resolve(bytes > 48000 * 4 ? true : err.trim().split('\n').pop() || 'no audio');
      });
      setTimeout(() => {
        yt.kill();
        f.kill();
      }, 60000);
    });
    if (ok === true) okMark('music download + decode works');
    else bad(`music download failed: ${ok}`, 'update yt-dlp, install deno, or set YTDLP_COOKIES');
  } else if (!song) console.log('\n(Tip: `npm run doctor -- "daft punk one more time"` also tests a real download.)');

  console.log(failed ? `\n${failed} problem(s) to fix.` : '\nAll good. Start Fig with: npm start');
  process.exit(failed ? 1 : 0);
}

main();
