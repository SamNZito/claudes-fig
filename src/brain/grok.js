'use strict';
// Thin xAI (Grok) client: chat + tools, vision, web-search answers, speech-to-text, text-to-speech.
// Docs: https://docs.x.ai  (chat: /v1/chat/completions, search: /v1/responses, STT: /v1/stt, TTS: /v1/tts)
const { config } = require('../config');
const log = require('../log').logger('grok');

let reasoningSupported = config.grokReasoning && config.grokReasoning !== 'none';
let sttFileField = 'file';
const REASONING_HEADROOM = 2000;

class GrokError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call(path, { method = 'POST', json, form, timeoutMs = 45000, raw = false } = {}) {
  const headers = { Authorization: `Bearer ${config.xaiKey}` };
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) body = form;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${config.xaiBase}${path}`, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        if (raw) return res;
        return await res.json();
      }
      const text = await res.text().catch(() => '');
      const err = new GrokError(`xAI ${path} ${res.status}: ${text.slice(0, 400)}`, res.status, text);
      if (res.status === 429 || res.status >= 500) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1) ** 2));
        continue;
      }
      throw err;
    } catch (e) {
      if (e instanceof GrokError) throw e;
      lastErr = e;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') break;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Chat completion with optional tools.
 * @returns {Promise<{content:string, toolCalls:Array<{id:string,name:string,args:object}>}>}
 */
async function chat({ messages, tools, model = config.grokModel, maxTokens = 600, temperature = 0.8, reasoning = config.grokReasoning, jsonMode = false }) {
  // Reasoning tokens count against the limit on reasoning models, so leave headroom for them.
  const body = { model, messages, max_tokens: maxTokens + REASONING_HEADROOM, temperature };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (jsonMode) body.response_format = { type: 'json_object' };
  if (reasoningSupported && reasoning && reasoning !== 'none') body.reasoning_effort = reasoning;
  let data;
  // Some models reject optional params. Drop the one the error names and retry (at most 3 times).
  for (let attempt = 0; ; attempt++) {
    try {
      data = await call('/chat/completions', { json: body });
      break;
    } catch (e) {
      if (e.status !== 400 || attempt >= 3) throw e;
      const msgText = String(e.body || '');
      if (body.reasoning_effort && /reasoning/i.test(msgText)) {
        log.warn('model rejected reasoning_effort; continuing without it');
        reasoningSupported = false;
        delete body.reasoning_effort;
      } else if (body.response_format && /response_format|json/i.test(msgText)) delete body.response_format;
      else if (body.temperature !== undefined && /temperature/i.test(msgText)) delete body.temperature;
      else if (body.reasoning_effort) {
        reasoningSupported = false;
        delete body.reasoning_effort;
      } else throw e;
    }
  }
  const msg = data?.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => {
    let args = {};
    try {
      args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : tc.function?.arguments || {};
    } catch {
      args = {};
    }
    return { id: tc.id, name: tc.function?.name, args };
  });
  const content = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((p) => p.text || '').join('') : '';
  return { content: content.trim(), toolCalls, raw: msg };
}

/** Ask for JSON and parse it (tolerates code fences / extra prose). */
async function chatJson({ system, user, maxTokens = 900, temperature = 0.9 }) {
  const { content } = await chat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    maxTokens,
    temperature,
    jsonMode: true,
  });
  return parseJson(content);
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Describe/answer about an image (data URL or https URL). */
async function vision({ system, question, imageUrl, maxTokens = 400 }) {
  const { content } = await chat({
    model: config.grokVisionModel || config.grokModel,
    maxTokens,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
          { type: 'text', text: question },
        ],
      },
    ],
  });
  return content;
}

/** Answer using live web search (Responses API + web_search tool). */
async function webAnswer({ instructions, input, maxTokens = 500 }) {
  const body = {
    model: config.grokModel,
    input: [
      { role: 'system', content: instructions },
      { role: 'user', content: input },
    ],
    tools: [{ type: 'web_search' }],
    max_output_tokens: maxTokens + REASONING_HEADROOM,
  };
  const data = await call('/responses', { json: body, timeoutMs: 90000 });
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const parts = [];
  for (const item of data.output || []) {
    if (item.type === 'message') for (const c of item.content || []) if (c.text) parts.push(c.text);
  }
  return parts.join('\n').trim();
}

/** Speech to text. `audio` is a WAV buffer. */
async function stt(audio, { keyterms = [], language = config.sttLanguage } = {}) {
  const build = (field) => {
    const form = new FormData();
    form.append(field, new Blob([audio], { type: 'audio/wav' }), 'speech.wav');
    if (config.sttModel) form.append('model', config.sttModel);
    if (language) form.append('language', language);
    for (const k of keyterms) if (k) form.append('keyterm', k);
    return form;
  };
  try {
    const data = await call('/stt', { form: build(sttFileField), timeoutMs: 30000 });
    return String(data.text || '').trim();
  } catch (e) {
    // Docs disagree on whether the field is "file" or "audio". Try the other once and remember.
    if (e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403 && e.status !== 429) {
      const other = sttFileField === 'file' ? 'audio' : 'file';
      const data = await call('/stt', { form: build(other), timeoutMs: 30000 });
      sttFileField = other;
      log.info(`STT works with field "${other}"`);
      return String(data.text || '').trim();
    }
    throw e;
  }
}

/** Text to speech. Returns encoded audio bytes (mp3 by default; decoded by ffmpeg later). */
async function tts(text, { voice = config.ttsVoice, language = config.ttsLanguage } = {}) {
  const res = await call('/tts', {
    json: {
      text,
      voice_id: voice,
      language,
      output_format: { codec: 'mp3', sample_rate: 48000, bit_rate: 128000 },
    },
    raw: true,
    timeoutMs: 30000,
  });
  const type = res.headers.get('content-type') || '';
  if (type.includes('json')) {
    const data = await res.json();
    if (!data.audio) throw new Error('TTS returned no audio');
    return Buffer.from(data.audio, 'base64');
  }
  return Buffer.from(await res.arrayBuffer());
}

let voiceCache = null;
async function listVoices() {
  if (voiceCache) return voiceCache;
  const fallback = ['eve', 'ara', 'rex', 'sal', 'leo', 'luna', 'orion', 'iris', 'helix', 'carina', 'zagan', 'aurora', 'atlas', 'celeste', 'cosmo', 'lux', 'kepler', 'rigel', 'sirius', 'lumen', 'castor', 'liora', 'altair', 'zenith', 'perseus', 'helios', 'ursa', 'naksh'];
  try {
    const data = await call('/tts/voices', { method: 'GET', timeoutMs: 15000 });
    const arr = Array.isArray(data) ? data : data.voices || data.data || [];
    const ids = arr.map((v) => (typeof v === 'string' ? v : v.voice_id || v.id || v.name)).filter(Boolean);
    voiceCache = ids.length ? ids.map((s) => String(s).toLowerCase()) : fallback;
  } catch (e) {
    log.debug('voice list unavailable:', e.message);
    voiceCache = fallback;
  }
  return voiceCache;
}

async function ping() {
  return call('/models', { method: 'GET', timeoutMs: 15000 });
}

module.exports = { chat, chatJson, parseJson, vision, webAnswer, stt, tts, listVoices, ping, GrokError };
