'use strict';
// Who may do what. Three capabilities, each limited to a list of roles (empty list = everyone):
//   ask     - talk to Fig and request songs
//   control - skip, pause, resume, stop, clear, remove, shuffle, volume, and change Fig's settings
//   dj      - turn DJ on/off and change its mood
// Members with Manage Server can always do everything.
const { PermissionFlagsBits } = require('discord.js');
const store = require('../store');

const CAPS = ['ask', 'control', 'dj'];

function isAdmin(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.ManageGuild));
}

function allowed(member, cap) {
  if (!member) return false;
  if (isAdmin(member)) return true;
  const roles = store.settings(member.guild.id).access?.[cap] || [];
  if (!roles.length) return true;
  return member.roles.cache.some((r) => roles.includes(r.id));
}

function denyMessage(cap) {
  return {
    ask: "You're not on the list of people who can ask me for things here.",
    control: "You're not allowed to control the music here.",
    dj: "You're not allowed to run the DJ here.",
  }[cap];
}

function setRoles(guildId, cap, roleIds) {
  const access = { ...store.settings(guildId).access, [cap]: [...new Set(roleIds)] };
  store.updateSettings(guildId, { access });
  return access[cap];
}

module.exports = { CAPS, allowed, isAdmin, denyMessage, setRoles };
