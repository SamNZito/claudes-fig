'use strict';
// Slash command definitions. Registered per guild on startup (instant updates).
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, InteractionContextType } = require('discord.js');
const { MODES } = require('../config');
const { PRESETS } = require('../brain/personalities');

const modeChoices = MODES.map((m) => ({ name: m === 'normal' ? 'normal (say my name first)' : 'conversation (no name needed)', value: m }));
const presetChoices = Object.entries(PRESETS).map(([k, v]) => ({ name: v.label, value: k }));
const capChoices = [
  { name: 'ask (talk to Fig, request songs)', value: 'ask' },
  { name: 'control (skip, pause, volume, settings)', value: 'control' },
  { name: 'dj (run the DJ)', value: 'dj' },
];

const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Fig joins your voice channel')
    .addChannelOption((o) => o.setName('channel').setDescription('Voice channel (defaults to yours)').addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)),
  new SlashCommandBuilder().setName('leave').setDescription('Fig leaves the voice channel'),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song (queues it if something is already playing)')
    .addStringOption((o) => o.setName('query').setDescription('Song name or URL').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('when')
        .setDescription('When to play it')
        .addChoices({ name: 'add to queue', value: 'queue' }, { name: 'next', value: 'next' }, { name: 'now (replaces current)', value: 'now' }),
    ),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Drop an upcoming song without stopping the current one')
    .addStringOption((o) => o.setName('which').setDescription('Queue position or words from the title').setRequired(true)),
  new SlashCommandBuilder().setName('pause').setDescription('Pause the music (stays paused until resumed)'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume the music'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop the music, clear the queue, turn DJ off'),
  new SlashCommandBuilder().setName('clear').setDescription('Clear upcoming songs (current keeps playing)'),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle upcoming songs'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the queue'),
  new SlashCommandBuilder().setName('nowplaying').setDescription("What's playing"),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Show or set the music volume')
    .addIntegerOption((o) => o.setName('level').setDescription('0-100').setMinValue(0).setMaxValue(100)),
  new SlashCommandBuilder()
    .setName('dj')
    .setDescription('DJ mode: keeps music going in a mood')
    .addSubcommand((s) =>
      s
        .setName('on')
        .setDescription('Turn DJ on')
        .addStringOption((o) => o.setName('mood').setDescription('e.g. "late night lofi", "2000s pop punk"')),
    )
    .addSubcommand((s) => s.setName('off').setDescription('Turn DJ off'))
    .addSubcommand((s) =>
      s
        .setName('mood')
        .setDescription('Change the DJ mood')
        .addStringOption((o) => o.setName('mood').setDescription('New mood').setRequired(true)),
    ),
  new SlashCommandBuilder()
    .setName('mode')
    .setDescription('normal = say my name first; conversation = no name needed')
    .addStringOption((o) => o.setName('mode').setDescription('Mode').setRequired(true).addChoices(...modeChoices)),
  new SlashCommandBuilder()
    .setName('name')
    .setDescription("Change Fig's wake name")
    .addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true).setMaxLength(24)),
  new SlashCommandBuilder()
    .setName('personality')
    .setDescription("Change how Fig talks")
    .addSubcommand((s) =>
      s
        .setName('preset')
        .setDescription('Pick a preset personality')
        .addStringOption((o) => o.setName('preset').setDescription('Personality').setRequired(true).addChoices(...presetChoices)),
    )
    .addSubcommand((s) =>
      s
        .setName('custom')
        .setDescription('Describe a personality and Fig becomes it')
        .addStringOption((o) => o.setName('description').setDescription('e.g. "a pirate who hates jazz"').setRequired(true).setMaxLength(200)),
    )
    .addSubcommand((s) => s.setName('show').setDescription('Show the current personality')),
  new SlashCommandBuilder()
    .setName('voice')
    .setDescription("Fig's spoken voice")
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Change the voice')
        .addStringOption((o) => o.setName('voice').setDescription('Voice name').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('List voices')),
  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Fig says a line in the call')
    .addStringOption((o) => o.setName('text').setDescription('What to say').setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder().setName('shutup').setDescription('Fig stops talking right now'),
  new SlashCommandBuilder().setName('forget').setDescription('Fig forgets the recent conversation and drops any image'),
  new SlashCommandBuilder().setName('status').setDescription("What Fig is doing"),
  new SlashCommandBuilder()
    .setName('timer')
    .setDescription('Timer announced in the call')
    .addStringOption((o) => o.setName('duration').setDescription('e.g. 5m, 90s, 1h30m').setRequired(true))
    .addStringOption((o) => o.setName('label').setDescription('What for')),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask Fig anything (answers in text and in the call)')
    .addStringOption((o) => o.setName('question').setDescription('Your question').setRequired(true)),
  new SlashCommandBuilder()
    .setName('look')
    .setDescription('Show Fig an image')
    .addAttachmentOption((o) => o.setName('image').setDescription('Screenshot or picture').setRequired(true))
    .addStringOption((o) => o.setName('question').setDescription('What do you want to know?')),
  new SlashCommandBuilder().setName('factcheck').setDescription('Fact-check the last claim someone made in the call'),
  new SlashCommandBuilder()
    .setName('mod')
    .setDescription('Moderation (needs the matching Discord permission)')
    .addStringOption((o) =>
      o
        .setName('action')
        .setDescription('What to do')
        .setRequired(true)
        .addChoices(
          { name: 'kick', value: 'kick' },
          { name: 'ban', value: 'ban' },
          { name: 'timeout', value: 'timeout' },
          { name: 'remove timeout', value: 'untimeout' },
          { name: 'server-mute', value: 'mute' },
          { name: 'unmute', value: 'unmute' },
          { name: 'pull out of voice', value: 'disconnect' },
        ),
    )
    .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
    .addIntegerOption((o) => o.setName('minutes').setDescription('Timeout length (default 5)').setMinValue(1).setMaxValue(40320))
    .addStringOption((o) => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder()
    .setName('access')
    .setDescription('Limit who can ask Fig, control music, or DJ')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('allow')
        .setDescription('Allow a role (once any role is set, only listed roles can)')
        .addStringOption((o) => o.setName('capability').setDescription('What').setRequired(true).addChoices(...capChoices))
        .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('disallow')
        .setDescription('Remove a role from the list')
        .addStringOption((o) => o.setName('capability').setDescription('What').setRequired(true).addChoices(...capChoices))
        .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('reset')
        .setDescription('Everyone can do this again')
        .addStringOption((o) => o.setName('capability').setDescription('What').setRequired(true).addChoices(...capChoices)),
    )
    .addSubcommand((s) => s.setName('show').setDescription('Show current limits')),
].map((c) => (typeof c.setContexts === 'function' && InteractionContextType ? c.setContexts(InteractionContextType.Guild) : c.setDMPermission(false)).toJSON());

module.exports = { commands };
