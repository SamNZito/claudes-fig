'use strict';
// Speech: text -> Grok TTS -> ffmpeg -> PCM clip for the mixer's voice lane.
const { spawn } = require('node:child_process');
const grok = require('../brain/grok');
const { PcmSource } = require('./pcmSource');
const { ffmpegPath } = require('./binaries');

/** Decode any audio bytes to 48 kHz stereo s16le. */
function decodeToPcm(bytes, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], {
      windowsHide: true,
    });
    const chunks = [];
    let err = '';
    const timer = setTimeout(() => {
      ff.kill('SIGKILL');
      reject(new Error('audio decode timed out'));
    }, timeoutMs);
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stderr.on('data', (d) => (err += d.toString()));
    ff.stdin.on('error', () => {});
    ff.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error('ffmpeg is not installed or not on PATH') : e);
    });
    ff.on('close', (code) => {
      clearTimeout(timer);
      const pcm = Buffer.concat(chunks);
      if (!pcm.length) reject(new Error(`ffmpeg could not decode audio: ${err.trim().slice(-200) || code}`));
      else resolve(pcm);
    });
    ff.stdin.end(bytes);
  });
}

/** Strip things that should not be read aloud (markdown, mentions, URLs, emoji). */
function speakable(text) {
  return String(text || '')
    .replace(/<@!?\d+>/g, '')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^>\s?/gm, '')
    .replace(/[*_`~#|]/g, '')
    .replace(/\s*\((translation|trans\.?)[^)]*\)/gi, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

/** Remove TTS speech tags for the text-channel version. */
function forText(text) {
  return String(text || '')
    .replace(/\[(pause|long-pause|laugh|chuckle|breath|sigh|tsk|tongue-click)\]/gi, '')
    .replace(/<\/?(whisper|soft|loud|slow|fast|higher-pitch|lower-pitch|emphasis|singing)>/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function synthesize(text, { voice } = {}) {
  const clean = speakable(text);
  if (!clean) return null;
  const bytes = await grok.tts(clean, { voice });
  const pcm = await decodeToPcm(bytes);
  const src = new PcmSource({ label: 'tts', maxBufferMs: 10 * 60 * 1000 });
  src.push(pcm);
  src.end();
  return src;
}

module.exports = { synthesize, decodeToPcm, speakable, forText };
