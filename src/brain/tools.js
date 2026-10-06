'use strict';
// The tools Grok can call when someone talks to Fig. Each maps 1:1 onto src/actions.js.
const actions = require('../actions');
const { MODES } = require('../config');
const { PRESETS } = require('./personalities');
const { ACTIONS: MOD_ACTIONS } = require('../discord/moderation');

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

const TOOLS = [
  fn(
    'play_music',
    'Play or queue a song. Always adds it to the queue. Never stops or replaces whatever is already playing. Use the most specific search text you can (artist + title), or a URL.',
    {
      query: { type: 'string', description: 'Artist and song title, or a URL' },
      when: { type: 'string', enum: ['queue', 'next'], description: 'queue (default) adds it at the end. next plays it after the current song. Never interrupt the current song.' },
    },
    ['query'],
  ),
  fn('skip_song', 'Skip the current song. It is gone; the next song plays.'),
  fn('remove_song', 'Drop an upcoming song from the queue without stopping the current one.', { which: { type: 'string', description: 'Queue position number or words from the title' } }, ['which']),
  fn('pause_music', 'Pause the music. It stays paused until someone resumes it.'),
  fn('resume_music', 'Resume paused music.'),
  fn('stop_music', 'Stop the music completely: current song, queue, and DJ.'),
  fn('clear_queue', 'Clear upcoming songs. The current song keeps playing.'),
  fn('shuffle_queue', 'Shuffle the upcoming songs.'),
  fn('set_volume', 'Set or nudge the music volume (0-100). Omit both to report it.', {
    level: { type: 'integer', minimum: 0, maximum: 100 },
    change: { type: 'string', enum: ['up', 'down'] },
  }),
  fn(
    'dj',
    'Control DJ mode, which keeps playing songs that fit a mood without anyone queueing.',
    { action: { type: 'string', enum: ['on', 'off', 'change_mood'] }, mood: { type: 'string', description: 'The vibe, e.g. "late night lofi", "2000s pop punk"' } },
    ['action'],
  ),
  fn('set_mode', 'Change how chatty Fig is.', { mode: { type: 'string', enum: MODES } }, ['mode']),
  fn('set_personality', 'Change how Fig talks. Use preset for a known one, or description to invent one.', {
    preset: { type: 'string', enum: Object.keys(PRESETS) },
    description: { type: 'string', description: 'A phrase describing a new personality' },
  }),
  fn('set_voice', "Change Fig's spoken voice.", { voice: { type: 'string' } }, ['voice']),
  fn('set_wake_name', 'Change the name people say to get Fig\'s attention.', { name: { type: 'string' } }, ['name']),
  fn('say_line', 'Say an exact line out loud because the user asked you to say it.', { text: { type: 'string' } }, ['text']),
  fn('stop_talking', 'Stop speaking immediately.'),
  fn('forget', 'Forget the recent conversation and drop any image you are holding.'),
  fn('drop_image', 'Drop the image you are holding.'),
  fn('status_report', 'Say what Fig is doing right now (channel, music, DJ, mode).'),
  fn(
    'set_timer',
    'Start a timer that Fig announces in the call when it ends.',
    { seconds: { type: 'integer', minimum: 1, maximum: 86400 }, label: { type: 'string' } },
    ['seconds'],
  ),
  fn('web_lookup', 'Look something up on the web for current facts, scores, news, prices, or anything you are not sure about.', { question: { type: 'string' } }, ['question']),
  fn('fact_check', 'Fact-check the most recent claim someone made in the call.'),
  fn('look_at_image', 'Look at the image you are holding (someone showed you a screenshot) and answer about it.', { question: { type: 'string' } }),
  fn(
    'moderate',
    'Kick, ban, time out, server-mute/unmute, or pull someone out of voice. Only works if the requester has that Discord permission.',
    {
      action: { type: 'string', enum: Object.keys(MOD_ACTIONS) },
      person: { type: 'string', description: 'Their name as said' },
      minutes: { type: 'integer', description: 'For timeout' },
      reason: { type: 'string' },
    },
    ['action', 'person'],
  ),
  fn('leave_call', 'Leave the voice channel because someone told you to.'),
  fn('stay_quiet', 'Say nothing because this was not meant for you or you have nothing useful to add.'),
];

const CHIME_TOOLS = TOOLS.filter((t) => t.function.name === 'stay_quiet');

async function runTool(ctx, name, args = {}) {
  const who = ctx.member?.displayName || ctx.member?.user?.username || '?';
  require('../log').logger('tool').info(`call ${name} by=${who} source=${ctx.source || '?'} args=${JSON.stringify(args)}`);
  switch (name) {
    case 'play_music':
      // Spoken requests queue. Skipping is skip_song. "now" used to cut off whatever was playing.
      return actions.play(ctx, { ...args, when: args.when === 'next' ? 'next' : 'queue' });
    case 'skip_song':
      return actions.skip(ctx);
    case 'remove_song':
      return actions.remove(ctx, args);
    case 'pause_music':
      return actions.pause(ctx);
    case 'resume_music':
      return actions.resume(ctx);
    case 'stop_music':
      return actions.stop(ctx);
    case 'clear_queue':
      return actions.clear(ctx);
    case 'shuffle_queue':
      return actions.shuffle(ctx);
    case 'set_volume':
      return actions.volume(ctx, args);
    case 'dj':
      return actions.dj(ctx, { action: args.action === 'change_mood' ? 'on' : args.action, mood: args.mood });
    case 'set_mode':
      return actions.setMode(ctx, args);
    case 'set_personality':
      return actions.setPersonality(ctx, args);
    case 'set_voice':
      return actions.setVoice(ctx, args);
    case 'set_wake_name':
      return actions.setName(ctx, args);
    case 'say_line':
      return actions.sayLine(ctx, args);
    case 'stop_talking':
      return actions.shutUp(ctx);
    case 'forget':
      return actions.forget(ctx);
    case 'drop_image':
      return actions.dropImage(ctx);
    case 'status_report':
      return actions.status(ctx);
    case 'set_timer':
      return actions.timer(ctx, args);
    case 'web_lookup':
      return actions.webLookup(ctx, args);
    case 'fact_check':
      return actions.factCheck(ctx);
    case 'look_at_image':
      return actions.look(ctx, args);
    case 'moderate':
      return actions.moderate(ctx, args);
    case 'leave_call':
      return actions.leave(ctx);
    case 'stay_quiet':
      return { ok: true, say: null, quiet: true };
    default:
      return { ok: false, say: null, text: `(unknown tool ${name})` };
  }
}

module.exports = { TOOLS, CHIME_TOOLS, runTool };
