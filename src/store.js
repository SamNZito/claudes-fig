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
    history: [], // { id, key, title, via, at }
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
  return load(guildId).settings;
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

module.exports = { load, settings, updateSettings, addHistory, history, flushAll, _cache: cache };
