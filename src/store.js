'use strict';
// Tiny per-guild JSON store. Settings + DJ memory survive restarts.
// Writes are debounced and atomic (write temp file, then rename).
const fs = require('node:fs');
const path = require('node:path');
const { config } = require('./config');
const log = require('./log').logger('store');

const cache = new Map();
const timers = new Map();

function defaults() {
  return {
    settings: {
      mode: config.defaultMode,
      wakeName: config.wakeName,
      personality: { preset: config.defaultPersonality, custom: null },
      voice: config.ttsVoice,
      volume: config.defaultVolume,
      access: { dj: [], control: [], ask: [] }, // role ids; empty = everyone
    },
    // Everything that has started playing (or been skipped) recently. Keyed by source id, never by title,
    // so two uploads of the same title are two different songs.
    history: [], // { id, key, title, channel, asked, via, how, at }
    // Songs someone skipped. Nothing automatic (DJ, fallback copy, queued DJ pick) may play them again
    // until they expire. Saved, so a restart doesn't bring them back either.
    skipped: [], // { tokens: [...], keys: [...], label, until }
    dj: { enabled: false, mood: '', at: 0 }, // restored after a restart
  };
}

function fileFor(guildId) {
  return path.join(config.dataDir, `guild-${guildId}.json`);
}

function merge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra === undefined ? base : extra;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null ? merge(base[k], v) : v;
  }
  return out;
}

function load(guildId) {
  if (cache.has(guildId)) return cache.get(guildId);
  let data = defaults();
  try {
    const raw = fs.readFileSync(fileFor(guildId), 'utf8');
    data = merge(defaults(), JSON.parse(raw));
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn(`could not read data for guild ${guildId}, using defaults:`, e.message);
  }
  cache.set(guildId, data);
  return data;
}

function save(guildId) {
  clearTimeout(timers.get(guildId));
  timers.set(
    guildId,
    setTimeout(() => flush(guildId), 500),
  );
}

function flush(guildId) {
  timers.delete(guildId);
  const data = cache.get(guildId);
  if (!data) return;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const file = fileFor(guildId);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    log.error(`failed to save guild ${guildId}:`, e.message);
  }
}

function flushAll() {
  for (const id of cache.keys()) flush(id);
}

function settings(guildId) {
  const st = load(guildId).settings;
  // Only "normal" and "conversation" exist now. Old saved modes (quiet/active/chaos) become normal.
  if (!config.MODES.includes(st.mode)) {
    st.mode = 'normal';
    save(guildId);
  }
  return st;
}

function updateSettings(guildId, patch) {
  const data = load(guildId);
  data.settings = merge(data.settings, patch);
  save(guildId);
  return data.settings;
}

function addHistory(guildId, entry) {
  const data = load(guildId);
  data.history.push({ ...entry, at: Date.now() });
  if (data.history.length > config.djMemorySize) data.history.splice(0, data.history.length - config.djMemorySize);
  save(guildId);
}

function history(guildId) {
  return load(guildId).history;
}

function skipped(guildId) {
  const data = load(guildId);
  const now = Date.now();
  const live = (data.skipped || []).filter((s) => s.until > now);
  if (live.length !== (data.skipped || []).length) {
    data.skipped = live;
    save(guildId);
  }
  return live;
}

function addSkipped(guildId, entry) {
  const data = load(guildId);
  data.skipped = [...skipped(guildId), entry].slice(-200);
  save(guildId);
}

function setSkipped(guildId, list) {
  load(guildId).skipped = list;
  save(guildId);
}

function setDj(guildId, dj) {
  load(guildId).dj = { ...dj, at: Date.now() };
  save(guildId);
}

function dj(guildId) {
  return load(guildId).dj || { enabled: false, mood: '', at: 0 };
}

module.exports = { load, settings, updateSettings, addHistory, history, skipped, addSkipped, setSkipped, setDj, dj, flushAll, _cache: cache };
