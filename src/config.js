'use strict';
// All tunables live here. Everything reads from environment variables (see .env.example).
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function str(name, def = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? def : String(v).trim();
}
function num(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined ? v : def;
}
function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v.trim());
}
function list(name) {
  return str(name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// normal: Fig needs its wake name. conversation: no wake name needed. Every call starts in normal.
const MODES = ['normal', 'conversation'];

const config = {
  discordToken: str('DISCORD_TOKEN'),
  xaiKey: str('XAI_API_KEY'),
  xaiBase: str('XAI_BASE_URL', 'https://api.x.ai/v1').replace(/\/+$/, ''),

  grokModel: str('GROK_MODEL', 'grok-4.7'),
  grokVisionModel: str('GROK_VISION_MODEL', ''), // empty = same as GROK_MODEL
  grokReasoning: str('GROK_REASONING_EFFORT', 'low'), // low | medium | high | xhigh | none
  sttModel: str('STT_MODEL', 'grok-voice-transcribe-2.0'),
  ttsVoice: str('TTS_VOICE', 'eve'),
  ttsLanguage: str('TTS_LANGUAGE', 'en'),
  sttLanguage: str('STT_LANGUAGE', 'en'),

  wakeName: str('WAKE_NAME', 'Fig'),
  defaultMode: MODES.includes(str('DEFAULT_MODE', 'normal')) ? str('DEFAULT_MODE', 'normal') : 'normal',
  defaultPersonality: str('DEFAULT_PERSONALITY', 'fig'),
  followupSeconds: num('FOLLOWUP_SECONDS', 12),
  // Every new call (and every restart) starts in normal mode.
  resetModeOnJoin: bool('RESET_MODE_ON_JOIN', true),

  defaultVolume: Math.max(0, Math.min(100, num('DEFAULT_VOLUME', 20))),
  duckLevel: Math.max(0, Math.min(1, num('DUCK_LEVEL', 0.25))),
  duckMode: str('DUCK_MODE', 'duck') === 'wait' ? 'wait' : 'duck',
  voiceVolume: Math.max(0.1, Math.min(2, num('VOICE_VOLUME', 1.0))),
  normalizeAudio: bool('NORMALIZE_AUDIO', true),
  maxTrackMinutes: num('MAX_TRACK_MINUTES', 20),
  trackStartTimeoutSec: num('TRACK_START_TIMEOUT_SEC', 30),
  stallTimeoutSec: num('STALL_TIMEOUT_SEC', 20),

  ytdlpPath: str('YTDLP_PATH', 'yt-dlp'),
  ffmpegPath: str('FFMPEG_PATH', ''),
  ytdlpCookies: str('YTDLP_COOKIES', ''),
  ytdlpExtraArgs: str('YTDLP_EXTRA_ARGS', '')
    .split(' ')
    .map((s) => s.trim())
    .filter(Boolean),
  // Route yt-dlp through a proxy, e.g. http://user:pass@host:port (only if SoundCloud blocks this machine's region).
  ytdlpProxy: str('YTDLP_PROXY', ''),
  // Spotify is used to look songs up (exact artist/title/length, Spotify links). Audio comes from SoundCloud.
  spotifyClientId: str('SPOTIFY_CLIENT_ID', ''),
  spotifyClientSecret: str('SPOTIFY_CLIENT_SECRET', ''),
  // Audio sources. Default: soundcloud only (YouTube is not used). A source that refuses this machine is skipped
  // for SOURCE_COOLDOWN_MIN (doubling, max 2 h).
  musicSources: list('MUSIC_SOURCES').map((s) => s.toLowerCase()),
  sourceCooldownMin: num('SOURCE_COOLDOWN_MIN', 10),
  probeTimeoutSec: num('PROBE_TIMEOUT_SEC', 30),
  resolveBudgetSec: num('RESOLVE_BUDGET_SEC', 60),
  // A copy that stops before this many seconds (and well short of its length) is a bad file / preview, not "the song ended".
  minSongSec: num('MIN_SONG_SEC', 45),
  // How long a skipped song stays banned from coming back (DJ, fallback copies, queue). An explicit request lifts it.
  skipBlockHours: num('SKIP_BLOCK_HOURS', 6),

  autoJoin: bool('AUTO_JOIN', true),
  // Fig's home voice channel (id or name, e.g. "zzzz"). It joins here on startup and comes back here after any restart.
  homeVoiceChannel: str('HOME_VOICE_CHANNEL', ''),
  // Stay in the home channel even when it is empty (so Fig is there when people arrive).
  stayInHome: bool('STAY_IN_HOME', true),
  emptyLeaveSeconds: num('EMPTY_LEAVE_SECONDS', 60),
  announceChannelId: str('ANNOUNCE_CHANNEL_ID', ''),
  guildIds: list('GUILD_IDS'),

  listen: bool('LISTEN', true),
  vadSilenceMs: num('VAD_SILENCE_MS', 800),
  minUtteranceMs: num('MIN_UTTERANCE_MS', 400),
  maxUtteranceSec: num('MAX_UTTERANCE_SEC', 20),

  djBatch: num('DJ_BATCH', 8),
  djMemorySize: num('DJ_MEMORY_SIZE', 400),
  djTalk: bool('DJ_TALK', false),

  dataDir: path.resolve(str('DATA_DIR', path.join(__dirname, '..', 'data'))),
  logLevel: str('LOG_LEVEL', 'info'),
};

config.MODES = MODES;

function validateConfig() {
  const problems = [];
  if (!config.discordToken) problems.push('DISCORD_TOKEN is missing');
  if (!config.xaiKey) problems.push('XAI_API_KEY is missing');
  return problems;
}

module.exports = { config, validateConfig, MODES };
