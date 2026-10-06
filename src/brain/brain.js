'use strict';
// Decides whether something said in the call is for Fig, and if so, what to do about it.
//
// Chattiness modes:
//   conversation - no wake name needed; anything could be for Fig (Grok may stay quiet)
//   quiet        - only when named (or a quick follow-up from the person Fig just answered)
//   normal       - named, follow-up, or a clear music ask ("skip this", "play ...")
//   active       - as normal, plus Fig sometimes chimes in when relevant
//   chaos        - Fig acts like another person in the call
// Outside conversation mode Fig only ever answers the person who addressed it.
const grok = require('./grok');
const { detectWake, norm } = require('./wake');
const { TOOLS, CHIME_TOOLS, runTool } = require('./tools');
const actions = require('../actions');
const { forText } = require('../audio/tts');
const store = require('../store');
const { config } = require('../config');
const log = require('../log').logger('brain');

// Things STT hallucinates on noise / music bleed.
const JUNK = /^(you|thank you\.?|thanks for watching!?|bye\.?|uh+|um+|hm+|mm+|ah+|oh+|\.+|okay\.?)$/i;

// Short commands handled locally: instant, no model call. Tested against the text with the name removed.
const FAST = [
  [/^(skip|next)( (it|this|that|this song|the song|song|track|this one))?( please)?$/, 'skip'],
  [/^(pause|hold on pause|pause (it|this|the music|music|the song))( please)?$/, 'pause'],
  [/^(resume|unpause|un pause|continue|keep playing|resume (it|the music|music)|play it again|press play)( please)?$/, 'resume'],
  [/^(stop|stop (it|the music|music|playing|the song))( please)?$/, 'stop'],
  [/^(stop talking|shut up|be quiet|quiet|shush|hush|zip it|enough)( please)?$/, 'shutup'],
  [/^(turn it up|louder|volume up|turn up( the music)?)( please)?$/, 'volup'],
  [/^(turn it down|quieter|softer|volume down|turn down( the music)?)( please)?$/, 'voldown'],
  [/^(set )?(the )?volume (to )?(\d{1,3})( percent)?$/, 'volset'],
  [/^shuffle( the queue| it)?( please)?$/, 'shuffle'],
  [/^(clear|clear the queue|clear queue)( please)?$/, 'clear'],
  [/^(what'?s|what is) (playing|this song|this)$/, 'np'],
  [/^(forget( it| that| everything)?|drop it|drop the image)$/, 'forget'],
];

// Doing one of these ends the turn. Fig should not keep treating the next sentences as for it.
const DONE_LISTENING = new Set([
  'play_music',
  'skip_song',
  'remove_song',
  'pause_music',
  'resume_music',
  'stop_music',
  'clear_queue',
  'shuffle_queue',
  'set_volume',
  'dj',
  'set_mode',
  'set_personality',
  'set_voice',
  'set_wake_name',
  'stop_talking',
  'forget',
  'drop_image',
  'leave_call',
  'moderate',
]);
const CLEAR_ASK = /^(skip( (this|it|the) ?(song|track|one)?)?|pause the music|resume the music|turn (the music|it) (up|down)|(can you |could you |please )?(play|queue|put on) .+|stop the music|next song|dj .+)$/;

class Brain {
  constructor(session) {
    this.session = session;
    this.chains = new Map(); // per-user sequential processing
    this.lastChimeEval = 0;
    this.lastChime = 0;
  }

  settings() {
    return store.settings(this.session.guild.id);
  }

  /** Called by the listener for every finished utterance. */
  onUtterance(u) {
    const prev = this.chains.get(u.userId) || Promise.resolve();
    const next = prev
      .then(() => this._utterance(u))
      .catch((e) => log.warn('utterance failed:', e.message));
    this.chains.set(u.userId, next);
    next.finally(() => this.chains.get(u.userId) === next && this.chains.delete(u.userId));
  }

  async _utterance({ userId, wav, durationMs }) {
    const s = this.session;
    const member = s.guild.members.cache.get(userId) || (await s.guild.members.fetch(userId).catch(() => null));
    if (!member || member.user.bot) return;
    const st = this.settings();
    let text;
    try {
      text = await grok.stt(wav, { keyterms: [st.wakeName] });
    } catch (e) {
      log.warn('STT failed:', e.message);
      return;
    }
    text = String(text || '').trim();
    if (!text || text.length < 2 || JUNK.test(text)) return;
    log.info(`${member.displayName}: ${text}`);
    s.memory.hear(userId, member.displayName, text);
    await this.route(member, text, { durationMs });
  }

  /** Decide whether/how to respond to something heard in the call. */
  async route(member, text, { source = 'voice' } = {}) {
    const s = this.session;
    const st = this.settings();
    const mode = st.mode;
    const { named, text: stripped } = detectWake(text, st.wakeName);
    const focused = s.isFocused(member.id);

    // Pending "yes" confirmation (voice bans).
    const pc = s.pendingConfirm;
    if (pc && pc.userId === member.id && Date.now() < pc.until) {
      const t = norm(named ? stripped : text);
      if (/^(yes|yeah|yep|yup|do it|confirm|confirmed|sure|go ahead)\b/.test(t)) {
        s.pendingConfirm = null;
        const r = await pc.run();
        return this.deliver(member, text, r.say || r.text, { source });
      }
      if (/^(no|nah|nope|cancel|never ?mind|don'?t)\b/.test(t)) {
        s.pendingConfirm = null;
        return this.deliver(member, text, 'Cancelled.', { source });
      }
    }

    let addressed = named || focused || mode === 'conversation';
    const cmdText = named ? stripped : norm(text);
    let clearAsk = false;
    if (!addressed && mode !== 'quiet' && CLEAR_ASK.test(cmdText)) addressed = clearAsk = true;

    if (addressed) {
      // While Fig is talking, "stop"/"shut up" from the person it's talking to cuts it off.
      const fast = fastCommand(cmdText);
      if (fast) return this.runFast(member, fast, cmdText, text, { source });
      return this.think(member, text, { named, focused, mode, source, clearAsk });
    }

    // Not addressed: maybe chime in.
    if (mode === 'active' || mode === 'chaos') {
      const words = text.split(/\s+/).length;
      const now = Date.now();
      const evalGap = mode === 'chaos' ? 6000 : 20000;
      const chimeGap = mode === 'chaos' ? 15000 : 60000;
      if (words >= (mode === 'chaos' ? 3 : 5) && now - this.lastChimeEval > evalGap && now - this.lastChime > chimeGap && !s.mixer.voiceActive) {
        this.lastChimeEval = now;
        return this.think(member, text, { named: false, focused: false, mode, chime: true, source });
      }
    }
  }

  async runFast(member, cmd, cmdText, original, { source }) {
    const ctx = this.session.ctx(member, source);
    let r;
    switch (cmd) {
      case 'skip':
        r = actions.skip(ctx);
        break;
      case 'pause':
        r = actions.pause(ctx);
        break;
      case 'resume':
        r = actions.resume(ctx);
        break;
      case 'stop':
        // "stop" while Fig is talking means stop talking, not stop the music.
        r = this.session.mixer.voiceActive ? actions.shutUp(ctx) : actions.stop(ctx);
        break;
      case 'shutup':
        r = actions.shutUp(ctx);
        break;
      case 'volup':
        r = actions.volume(ctx, { change: 'up' });
        break;
      case 'voldown':
        r = actions.volume(ctx, { change: 'down' });
        break;
      case 'volset':
        r = actions.volume(ctx, { level: Number(cmdText.match(/(\d{1,3})/)[1]) });
        break;
      case 'shuffle':
        r = actions.shuffle(ctx);
        break;
      case 'clear':
        r = actions.clear(ctx);
        break;
      case 'np':
        r = actions.nowPlaying(ctx);
        break;
      case 'forget':
        r = actions.forget(ctx);
        break;
      default:
        return;
    }
    log.info(`fast command "${cmd}" from ${member.displayName}: ${r.ok ? 'ok' : r.say}`);
    this.session.postLog(member, original, r);
    if (r.say && cmd !== 'shutup') await this.deliver(member, original, r.say, { source, focus: false });
  }

  buildSystem(member, { mode, chime, named, focused, clearAsk }) {
    const s = this.session;
    const st = this.settings();
    const np = s.player.nowPlaying();
    const upcoming = s.player.queue.items.slice(0, 5).map((e, i) => `${i + 1}. ${e.title}`);
    const people = s.peopleInCall().join(', ') || 'unknown';
    const convo = s.memory
      .recentTranscript(14)
      .map((l) => `${l.name}: ${l.text}`)
      .join('\n');
    const rules = [
      `Your name is "${st.wakeName}". You're in the Discord server "${s.guild.name}", sitting in a voice call with friends. You run the music and help out.`,
      'What you say is spoken aloud with text-to-speech and also posted in chat, so: 1-2 short sentences (under 35 words) unless asked for detail. No markdown, lists, emojis or URLs.',
      `You are replying to ${member.displayName}. Talk to them only.`,
      'Use tools to actually do things. Never claim a song is playing: the system announces songs when their audio really starts. After play_music, say at most a few words or nothing.',
      'play_music adds the song to the queue and leaves the current song playing. Do not skip, stop, or replace the current song just because someone asked for a different one. Only skip_song interrupts what is playing, and only when they asked to skip.',
      "If you can't tell what song or person they mean, ask one short question.",
      'Your personality changes how you talk, never whether you do the job. You may use speech tags like [laugh], [sigh], [pause], <whisper>...</whisper> sparingly.',
      'For current events, scores, prices or anything you are unsure of, use web_lookup instead of guessing.',
    ];
    if (chime) {
      rules.push(
        mode === 'chaos'
          ? 'Nobody addressed you. You are another friend in this call: jump in with a quick reaction, joke or opinion if you have a good one; otherwise call stay_quiet.'
          : 'Nobody addressed you. Only chime in if you have something genuinely relevant and useful to add (a quick fact, a fitting song idea). Usually call stay_quiet.',
      );
    } else if (clearAsk) {
      rules.push(`${member.displayName} did not say your name, but this sounded like a music request for you. If it clearly isn't (they're just chatting), call stay_quiet.`);
    } else if (!named && focused) {
      rules.push(`${member.displayName} talked to you a moment ago and did not say your name this time. If this is clearly not for you (they're talking to someone else), call stay_quiet.`);
    } else if (!named && mode === 'conversation') {
      rules.push("Conversation mode: people don't need to say your name. If this is clearly people talking to each other and not to you, call stay_quiet.");
    }
    const state = [
      `Music: ${np ? `${np.status === 'loading' ? 'loading' : np.paused ? 'paused' : 'playing'} "${np.entry.title}"` : 'nothing playing'}. Volume ${s.player.volume}%.`,
      `Up next: ${upcoming.length ? upcoming.join('; ') : 'nothing'}.`,
      `DJ: ${s.dj.enabled ? `on, mood "${s.dj.mood}"` : 'off'}. Mode: ${mode}.`,
      `People in the call: ${people}.`,
      s.memory.heldImage() ? `You are holding an image ${s.memory.heldImage().from} showed you (use look_at_image).` : 'You are not holding any image.',
    ];
    return `${s.personaPrompt()}\n\n# Rules\n- ${rules.join('\n- ')}\n\n# Right now\n${state.join('\n')}\n\n# Recent talk in the call (oldest first)\n${convo || '(nothing yet)'}`;
  }

  /** Full model round: decide, call tools, reply. */
  async think(member, text, { named = false, focused = false, mode = this.settings().mode, chime = false, clearAsk = false, source = 'voice', reply = null } = {}) {
    const s = this.session;
    const system = this.buildSystem(member, { mode, chime, named, focused, clearAsk });
    const messages = [{ role: 'system', content: system }, ...s.memory.exchanges.slice(-8), { role: 'user', content: `${member.displayName}: ${text}` }];
    if (!chime && source === 'voice') s.mixer.holdDuck(1500);
    let result;
    try {
      result = await grok.chat({ messages, tools: chime ? CHIME_TOOLS : TOOLS, maxTokens: 400 });
    } catch (e) {
      log.warn('Grok chat failed:', e.message);
      if (!chime) await this.deliver(member, text, "Sorry, my brain glitched. Say that again?", { source, reply });
      return;
    }

    const ctx = s.ctx(member, source);
    const said = [];
    const failures = [];
    const answers = [];
    let quiet = false;
    let verbatim = null;
    let startedMusic = false;
    const texts = [];
    let doneListening = false;
    for (const call of result.toolCalls) {
      let r;
      try {
        r = await runTool(ctx, call.name, call.args);
      } catch (e) {
        log.warn(`tool ${call.name} threw:`, e.message);
        r = { ok: false, say: "Something went wrong doing that." };
      }
      log.info(`tool ${call.name}(${JSON.stringify(call.args)}) -> ${r.ok ? 'ok' : 'failed'}${r.say ? `: ${r.say}` : ''}`);
      if (DONE_LISTENING.has(call.name)) doneListening = true;
      if (r.quiet) quiet = true;
      if (!r.ok) failures.push(r.say || r.text);
      else if (r.verbatim) verbatim = r.say;
      else if (r.answer) answers.push(r.say);
      else if (r.say) said.push(r.say);
      if (r.startsNow) startedMusic = true;
      if (r.text && r.text !== r.say) texts.push(r.text);
    }

    let final;
    if (failures.length) final = failures.join(' ');
    else if (verbatim) final = verbatim;
    else if (answers.length) final = answers.join(' ');
    else if (quiet && !result.content) final = null;
    else if (result.content) final = result.content;
    else final = said.join(' ') || null;
    if (quiet && result.toolCalls.length === 1) final = null;

    if (reply) {
      // Text request (/ask or a mention): one combined reply, and speak it in the call if Fig is there.
      if (doneListening) s.clearFocus();
      const combined = [...texts, final ? forText(final) : null].filter(Boolean).join('\n') || 'Done.';
      if (final) {
        s.memory.addExchange(`${member.displayName}: ${text}`, final);
        s.memory.figSaid(final, member.displayName);
      }
      await reply(combined).catch((e) => log.warn('reply failed:', e.message));
      if (final && s.connection) await s.speak(final);
      return;
    }
    if (texts.length) s.postText(texts.join('\n'));
    if (doneListening) s.clearFocus();
    if (!final) {
      // A finished command, or staying quiet, does not keep the mic open.
      if (!chime) s.memory.addExchange(`${member.displayName}: ${text}`, startedMusic ? '(started the music)' : '(did it)');
      return;
    }
    if (chime) this.lastChime = Date.now();
    await this.deliver(member, text, final, { source, reply, verbatim: Boolean(verbatim), chime, focus: !doneListening });
  }

  /** Speak + post a reply to one person, remember it, keep focus on them for follow-ups. */
  async deliver(member, heard, line, { source = 'voice', reply = null, verbatim = false, focus = true, chime = false } = {}) {
    const s = this.session;
    if (!line) return;
    s.memory.addExchange(`${member.displayName}: ${heard}`, line);
    s.memory.figSaid(line, member.displayName);
    if (focus && !chime) s.setFocus(member.id);
    await s.respond({ member, text: line, source, reply, verbatim, mention: !chime });
  }

  /** Text entry point: /ask, or a message that mentions Fig. */
  async handleText(member, text, { reply, image } = {}) {
    const s = this.session;
    s.memory.hear(member.id, member.displayName, text);
    if (image) {
      const r = await actions.look(s.ctx(member, 'text'), { question: text || 'What do you see?', image });
      return this.deliver(member, text || '(showed an image)', r.say || r.text, { source: 'text', reply });
    }
    return this.think(member, text, { named: true, source: 'text', reply });
  }
}

function fastCommand(t) {
  const clean = String(t || '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [re, cmd] of FAST) if (re.test(clean)) return cmd;
  return null;
}

module.exports = { Brain, fastCommand, CLEAR_ASK, JUNK };
