'use strict';
// Two copies of Fig on the same bot token fight over the voice channel: each one keeps rejoining,
// and every rejoin plays a few seconds of THAT copy's music (old songs cutting into the current one).
//
// Discord tells us when this happens. Every voice state carries the id of the gateway session that
// owns it. If our bot user's voice state shows up with a session id that is not one of ours, another
// copy of Fig just took the voice channel.
class InstanceGuard {
  constructor() {
    this.ours = new Set(); // every gateway session id this process has had
    this.current = null;
  }

  /** Feed raw gateway packets (client.on('raw')). */
  onRaw(packet) {
    if (packet && packet.t === 'READY' && packet.d && packet.d.session_id) {
      this.current = packet.d.session_id;
      this.ours.add(packet.d.session_id);
    }
  }

  /** Is this voice state (for our own bot user) owned by some other process? */
  isForeign(voiceState) {
    return Boolean(voiceState && voiceState.channelId && voiceState.sessionId && this.current && !this.ours.has(voiceState.sessionId));
  }
}

module.exports = { InstanceGuard };
