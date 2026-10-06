'use strict';
// Shared test setup: fake yt-dlp, temp data dir, a fake Discord guild/member, and a scriptable Grok.
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
process.env.YTDLP_PATH = path.join(__dirname, 'fixtures', 'fake-ytdlp.js');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'figtest-'));
process.env.NORMALIZE_AUDIO = process.env.NORMALIZE_AUDIO || 'false';
process.env.TRACK_START_TIMEOUT_SEC = '3';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.DISCORD_TOKEN = 'test';
process.env.XAI_API_KEY = 'test';
try { fs.chmodSync(process.env.YTDLP_PATH, 0o755); } catch { /* windows */ }

const grok = require('../src/brain/grok');

// Scriptable Grok: push responses; each chat() call shifts one.
const script = { chat: [], json: [], stt: [], calls: [] };
grok.chat = async (req) => {
  script.calls.push(req);
  const next = script.chat.shift();
  if (typeof next === 'function') return next(req);
  return next || { content: '', toolCalls: [] };
};
grok.chatJson = async (req) => {
  script.calls.push(req);
  const next = script.json.shift();
  if (next instanceof Error) throw next;
  return typeof next === 'function' ? next(req) : next;
};
grok.stt = async () => script.stt.shift() || '';
grok.tts = async () => fs.readFileSync(path.join(__dirname, 'fixtures', 'tone.mp3'));
grok.webAnswer = async ({ input }) => `web says: ${String(input).slice(0, 40)}`;
grok.listVoices = async () => ['eve', 'ara', 'rex'];

function fakeGuild(id = 'guild1') {
  const members = new Map();
  const guild = {
    id,
    name: 'Super Chill Discord',
    ownerId: 'owner',
    members: { cache: members, fetch: async (uid) => members.get(uid) || null, me: null, search: async () => new Map() },
    channels: { cache: new Map() },
    voiceAdapterCreator: () => ({ sendPayload: () => true, destroy: () => {} }),
  };
  return guild;
}

function fakeMember(guild, id, name, { admin = false, roles = [] } = {}) {
  const m = {
    id,
    displayName: name,
    user: { id, username: name.toLowerCase(), bot: false, tag: `${name}#0001` },
    guild,
    roles: { cache: { some: (fn) => roles.some((r) => fn({ id: r })) }, highest: { comparePositionTo: () => -1 } },
    permissions: { has: () => admin },
    voice: { channel: null, channelId: null },
  };
  guild.members.cache.set(id, m);
  return m;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(10);
  }
  return false;
}

module.exports = { script, fakeGuild, fakeMember, sleep, waitFor, grok };
