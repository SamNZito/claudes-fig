'use strict';
// Kick, ban, timeout, server-mute, pull out of voice. Only for people who have the matching Discord
// permission themselves, and only when Fig's role is allowed to do it.
const { PermissionFlagsBits } = require('discord.js');
const { norm, lev } = require('../brain/wake');

const ACTIONS = {
  kick: { perm: PermissionFlagsBits.KickMembers, label: 'kick' },
  ban: { perm: PermissionFlagsBits.BanMembers, label: 'ban' },
  timeout: { perm: PermissionFlagsBits.ModerateMembers, label: 'time out' },
  untimeout: { perm: PermissionFlagsBits.ModerateMembers, label: 'remove the timeout for' },
  mute: { perm: PermissionFlagsBits.MuteMembers, label: 'server-mute', voice: true },
  unmute: { perm: PermissionFlagsBits.MuteMembers, label: 'unmute', voice: true },
  disconnect: { perm: PermissionFlagsBits.MoveMembers, label: 'pull out of voice', voice: true },
};

/**
 * Find a member by spoken/typed name. Prefers people in the given voice channel.
 * @returns {Promise<{member?:import('discord.js').GuildMember, ambiguous?:string[]}>}
 */
async function resolveMember(guild, name, voiceChannel) {
  const q = norm(name).replace(/^@/, '');
  if (!q) return {};
  const idMatch = String(name).match(/\d{15,}/);
  if (idMatch) {
    const m = await guild.members.fetch(idMatch[0]).catch(() => null);
    if (m) return { member: m };
  }
  const score = (m) => {
    const names = [m.displayName, m.user.globalName, m.user.username, m.nickname].filter(Boolean).map(norm);
    let best = 99;
    for (const n of names) {
      if (n === q) return 0;
      if (n.startsWith(q) || n.split(' ')[0] === q) best = Math.min(best, 1);
      else if (q.length >= 4 && lev(n, q) <= 2) best = Math.min(best, 2);
      else if (q.length >= 4 && n.includes(q)) best = Math.min(best, 2);
    }
    return best;
  };
  const pick = (members) => {
    const ranked = members
      .filter((m) => !m.user.bot)
      .map((m) => ({ m, s: score(m) }))
      .filter((x) => x.s < 99)
      .sort((a, b) => a.s - b.s);
    if (!ranked.length) return null;
    const top = ranked.filter((x) => x.s === ranked[0].s);
    if (top.length > 1) return { ambiguous: top.slice(0, 5).map((x) => x.m.displayName) };
    return { member: top[0].m };
  };
  if (voiceChannel) {
    const r = pick([...voiceChannel.members.values()]);
    if (r) return r;
  }
  const found = await guild.members.search({ query: q.split(' ')[0], limit: 20 }).catch(() => null);
  if (found) {
    const r = pick([...found.values()]);
    if (r) return r;
  }
  return {};
}

/**
 * @returns {Promise<{ok:boolean, message:string}>}
 */
async function moderate({ guild, actor, target, action, minutes = 5, reason = '' }) {
  const spec = ACTIONS[action];
  if (!spec) return { ok: false, message: `I don't know how to ${action}.` };
  if (!actor?.permissions?.has(spec.perm)) return { ok: false, message: `You don't have permission to ${spec.label} people.` };
  const me = guild.members.me;
  if (!me?.permissions?.has(spec.perm)) return { ok: false, message: `I don't have permission to ${spec.label} people here.` };
  if (target.id === me.id) return { ok: false, message: 'Nice try.' };
  if (target.id === guild.ownerId) return { ok: false, message: "I can't do that to the server owner." };
  if (actor.id !== guild.ownerId && target.roles.highest.comparePositionTo(actor.roles.highest) >= 0) {
    return { ok: false, message: `${target.displayName} is at or above your role, so I won't.` };
  }
  const why = `${reason || 'via Fig'} (requested by ${actor.user.tag})`.slice(0, 500);
  try {
    switch (action) {
      case 'kick':
        if (!target.kickable) return { ok: false, message: `My role is too low to kick ${target.displayName}.` };
        await target.kick(why);
        return { ok: true, message: `Kicked ${target.displayName}.` };
      case 'ban':
        if (!target.bannable) return { ok: false, message: `My role is too low to ban ${target.displayName}.` };
        await guild.members.ban(target, { reason: why });
        return { ok: true, message: `Banned ${target.displayName}.` };
      case 'timeout': {
        if (!target.moderatable) return { ok: false, message: `My role is too low to time out ${target.displayName}.` };
        const mins = Math.max(1, Math.min(40320, Math.round(minutes || 5)));
        await target.timeout(mins * 60 * 1000, why);
        return { ok: true, message: `Timed out ${target.displayName} for ${mins} minute${mins === 1 ? '' : 's'}.` };
      }
      case 'untimeout':
        if (!target.moderatable) return { ok: false, message: `My role is too low for that.` };
        await target.timeout(null, why);
        return { ok: true, message: `Removed ${target.displayName}'s timeout.` };
      case 'mute':
      case 'unmute':
      case 'disconnect':
        if (!target.voice?.channelId) return { ok: false, message: `${target.displayName} isn't in voice.` };
        if (action === 'disconnect') await target.voice.disconnect(why);
        else await target.voice.setMute(action === 'mute', why);
        return {
          ok: true,
          message: action === 'disconnect' ? `Pulled ${target.displayName} out of voice.` : `${action === 'mute' ? 'Server-muted' : 'Unmuted'} ${target.displayName}.`,
        };
      default:
        return { ok: false, message: 'Unknown action.' };
    }
  } catch (e) {
    return { ok: false, message: `Discord refused: ${e.message}` };
  }
}

module.exports = { ACTIONS, resolveMember, moderate };
