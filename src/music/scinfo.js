'use strict';
// What SoundCloud itself says about an upload, before Fig spends a probe on it.
//
// SoundCloud's web API (api-v2, the one soundcloud.com uses) tells us outright when a track can't be
// played in full: `policy: "SNIP"` means only a 30-second preview, "BLOCK" means not available here,
// and streams whose protocol is ctr-/cbc-encrypted-hls are DRM-locked. Major-label songs are usually one
// of these. Checking first means locked copies are skipped instantly and the reason is exact, instead of
// probing each one with yt-dlp. It also tells us when an upload comes from the label (publisher
// metadata) or a verified account, which helps pick the official copy.
//
// It needs SoundCloud's public web client_id, read from soundcloud.com's own scripts the way yt-dlp does
// (or set SOUNDCLOUD_CLIENT_ID). If anything here fails, Fig simply probes as before.
// Off: SOUNDCLOUD_CHECK=off.
const fs = require('node:fs');
const path = require('node:path');
const log = require('../log').logger('scinfo');

const CACHE_FILE = path.join(require('../config').config.dataDir, 'soundcloud-client-id');
const INFO_TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
const USABLE = new Set(['progressive', 'hls']); // what yt-dlp plays without decryption keys

const infoCache = new Map(); // id -> { at, info }
let clientId = null;
let clientIdAt = 0;
let disabledUntil = 0; // after repeated failures, stop asking for a while

function enabled() {
  return String(process.env.SOUNDCLOUD_CHECK || 'on').toLowerCase() !== 'off' && Date.now() >= disabledUntil;
}

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json, text/html' } });
  return res;
}

/** SoundCloud's public web client_id: env, cache file, or read from soundcloud.com's scripts. */
async function getClientId({ refresh = false } = {}) {
  if (process.env.SOUNDCLOUD_CLIENT_ID) return process.env.SOUNDCLOUD_CLIENT_ID;
  if (!refresh && clientId && Date.now() - clientIdAt < 24 * 60 * 60 * 1000) return clientId;
  if (!refresh) {
    try {
      const [id, at] = fs.readFileSync(CACHE_FILE, 'utf8').trim().split(' ');
      if (/^[A-Za-z0-9]{32}$/.test(id) && Date.now() - Number(at) < 24 * 60 * 60 * 1000) {
        clientId = id;
        clientIdAt = Number(at);
        return clientId;
      }
    } catch {
      /* no cache yet */
    }
  }
  const home = await get('https://soundcloud.com/');
  if (!home.ok) throw new Error(`soundcloud.com answered ${home.status}`);
  const html = await home.text();
  const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/[^"]+\.js)"/g)].map((m) => m[1]).reverse();
  for (const src of scripts.slice(0, 8)) {
    try {
      const js = await (await get(src)).text();
      const m = js.match(/client_id\s*[:=]\s*"([A-Za-z0-9]{32})"/) || js.match(/client_id=([A-Za-z0-9]{32})/);
      if (m) {
        clientId = m[1];
        clientIdAt = Date.now();
        try {
          fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
          fs.writeFileSync(CACHE_FILE, `${clientId} ${clientIdAt}\n`);
        } catch {
          /* cache is optional */
        }
        log.info('got SoundCloud web client_id');
        return clientId;
      }
    } catch {
      /* try the next script */
    }
  }
  throw new Error("couldn't find SoundCloud's client_id");
}

/** Raw api-v2 track -> what Fig needs. */
function summarize(t) {
  const transcodings = (t?.media?.transcodings || []).map((x) => ({ protocol: String(x?.format?.protocol || ''), snipped: Boolean(x?.snipped), preset: x?.preset || '' }));
  const pm = t?.publisher_metadata || {};
  return {
    id: String(t.id),
    policy: String(t.policy || '').toUpperCase(),
    monetization: t.monetization_model || '',
    durationSec: Math.round((Number(t.duration) || 0) / 1000),
    fullSec: Math.round((Number(t.full_duration) || Number(t.duration) || 0) / 1000),
    transcodings,
    labelArtist: pm.artist || '',
    isrc: pm.isrc || '',
    label: t.label_name || pm.p_line || '',
    verified: Boolean(t?.user?.verified),
    uploader: t?.user?.username || '',
    url: t.permalink_url || '',
  };
}

/**
 * Can Fig play this in full? { playable, kind, reason }
 *   kind: 'preview' (only a 30 s preview), 'drm' (locked streams), 'blocked' (not available here)
 */
function verdict(info) {
  if (!info) return { playable: true };
  if (info.policy === 'BLOCK') return { playable: false, kind: 'blocked', reason: 'SoundCloud blocks it in this region' };
  if (info.policy === 'SNIP') return { playable: false, kind: 'preview', reason: 'SoundCloud only offers a 30-second preview of it' };
  const full = info.transcodings.filter((x) => !x.snipped);
  if (info.transcodings.length && !full.length) return { playable: false, kind: 'preview', reason: 'SoundCloud only offers a 30-second preview of it' };
  if (full.length && !full.some((x) => USABLE.has(x.protocol))) return { playable: false, kind: 'drm', reason: 'SoundCloud only streams it DRM-locked' };
  return { playable: true };
}

/** Is this upload from the label/distributor or a verified account? */
function official(info) {
  return Boolean(info && (info.labelArtist || info.isrc || info.verified));
}

/**
 * Look up several SoundCloud track ids at once. Returns Map(id -> info). Never throws: on any problem
 * it returns what it has (possibly nothing) and Fig probes as before.
 */
async function lookupTracks(ids) {
  const out = new Map();
  if (!enabled()) return out;
  const want = [];
  for (const raw of ids) {
    const id = String(raw || '');
    if (!/^\d+$/.test(id)) continue;
    const c = infoCache.get(id);
    if (c && Date.now() - c.at < INFO_TTL_MS) out.set(id, c.info);
    else want.push(id);
  }
  if (!want.length) return out;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cid = await getClientId({ refresh: attempt > 0 });
      const res = await get(`https://api-v2.soundcloud.com/tracks?ids=${want.slice(0, 50).join(',')}&client_id=${cid}`);
      if ((res.status === 401 || res.status === 403) && attempt === 0) {
        clientId = null; // the client_id rotated; read a fresh one
        continue;
      }
      if (!res.ok) throw new Error(`api-v2 answered ${res.status}`);
      const list = await res.json();
      for (const t of Array.isArray(list) ? list : list?.collection || []) {
        if (!t || t.id === undefined) continue;
        const info = summarize(t);
        infoCache.set(info.id, { at: Date.now(), info });
        out.set(info.id, info);
      }
      break;
    }
  } catch (e) {
    log.warn(`SoundCloud track check skipped (${e.message}); probing as usual`);
    disabledUntil = Date.now() + 10 * 60 * 1000;
  }
  return out;
}

function _reset() {
  infoCache.clear();
  clientId = null;
  clientIdAt = 0;
  disabledUntil = 0;
}

module.exports = { lookupTracks, verdict, official, summarize, getClientId, _reset };
