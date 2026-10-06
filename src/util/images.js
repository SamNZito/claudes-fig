'use strict';
// Download an image and turn it into a data URL Grok vision accepts (PNG or JPEG).
const { spawn } = require('node:child_process');
const { ffmpegPath } = require('../audio/binaries');

const MAX_BYTES = 15 * 1024 * 1024;

function toPng(bytes) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1'], { windowsHide: true });
    const out = [];
    ff.stdout.on('data', (d) => out.push(d));
    ff.stdin.on('error', () => {});
    ff.on('error', reject);
    ff.on('close', () => {
      const b = Buffer.concat(out);
      if (b.length) resolve(b);
      else reject(new Error('unsupported image format'));
    });
    ff.stdin.end(bytes);
  });
}

function sniff(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  return null;
}

async function decodeImage(url, contentType = '') {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('image is too big (15 MB max)');
  let bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error('image is too big (15 MB max)');
  let type = sniff(bytes);
  if (!type) {
    bytes = await toPng(bytes);
    type = 'image/png';
  }
  void contentType;
  return `data:${type};base64,${bytes.toString('base64')}`;
}

module.exports = { decodeImage };
