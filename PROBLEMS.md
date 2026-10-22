# Problems and what was done about them

Fig is the Discord voice bot in this repo (Jit#3217, guild Super Chill, channel #zzzz). It runs as one process: `node scripts/supervise.js`, which runs `src/index.js`. Do not run a second Discord client on the same token. The old website worker was removed for that reason, and Fig now refuses to start a second copy of itself.

Logs while it runs are `logs/fig.log` (everything), `logs/conversation.log` (only what was said, by people and by Fig) and `logs/crash.log` (starts, kills, freezes, voice events). README "Logs" explains every line. Neither is committed, and neither is `.env`. Copy `.env.example` to make one.

Every item below has a regression test in `test/playback.test.js` or `test/supervise.test.js`. Run `npm test`.

## 1. YouTube audio does not download from the host

**Decision (Oct 2026): YouTube is not used at all.** Audio comes from SoundCloud only. Spotify is used to look songs up: the real artist, title and length, plus Spotify links. Spotify audio can't be streamed by a bot.

- `src/music/lookup.js` turns a request into songs. Text goes to Spotify search, or to SoundCloud search when no Spotify keys are set. Spotify links (track or album) are read from Spotify. A YouTube link is used only for its title.
- `src/music/resolve.js` finds a full SoundCloud copy. It searches by the Spotify artist and title, rejects copies whose length doesn't match Spotify's, then probes each copy (rejecting previews and DRM).
- If no full copy exists, Fig says "SoundCloud only has previews or locked copies of X" right away.
- Test: `#1 YouTube is never used` checks that yt-dlp makes zero YouTube calls.

The earlier bug, where any error containing "page" was reported as "age-restricted", is still fixed.

## 2. The SoundCloud fallback was a 30-second preview

**Cause.** SoundCloud serves previews for many tracks. yt-dlp marks those formats `_preview`, but `bestaudio` still picked them when nothing else existed. Then 30 seconds of audio ended and was treated as "the song finished".

**Fix.**

- Every copy is probed before it plays (`yt-dlp -J`, in `src/music/resolve.js`).
- The format selector excludes previews (`[format_id!*=preview]`). A preview-only or DRM track is rejected at probe time and is never heard.
- The real download reuses the probe (`--load-info-json`), so nothing is extracted twice.
- If a copy still stops after less than `MIN_SONG_SEC` (45 s) and well short of its length, it is a bad copy, not the end of the song. Another copy of the same request plays. If none exists, the room is told why.

Volume was never the cause. `setVolume` only changes the mixer gain, and its log line now says that playback was untouched. Every stream end logs `played=Xs of Ys`, so a short file is visible in the log.

## 3. Skipped songs came back

**Cause.** Several paths could restart a skipped song:

- The early-end and stall handlers restarted the same entry.
- The fallback started another upload of the same title.
- A DJ refill started a second song while a start was already in progress.
- The DJ's memory compared source ids, so a SoundCloud upload of a skipped YouTube song didn't match.

**Fix.** `src/music/player.js` was rewritten around requests.

- A queue entry is a request (what was asked for). The upload is chosen only when the request is due. Swapping a bad copy, or resuming after a network cut, happens inside that one request.
- Skip sets `cancelled` on the request. Every async path (probe, retry, resume, prefetch) checks it before it acts, so a skipped request can't restart.
- Skip records the song in a skip memory saved in `data/guild-<id>.json` (`SKIP_BLOCK_HOURS`, default 6 h). The memory matches by song, not by upload, using `src/music/identity.js`. For example, "Eagles - Please Come Home for Christmas (Official Audio)" on YouTube equals "Please Come Home for Christmas (2013 Remaster)" by Eagles on SoundCloud. "Dreams" does not equal "Sweet Dreams".
- The skip memory is checked by the DJ, by copy selection, by the start of every queued item, and against duplicates already queued (those are dropped at skip time). It also survives a restart.
- Asking for the song again on purpose lifts the block.
- A DJ refill never starts a song itself while a start is in progress.

**Log to look for:**

- `blocked for 6h: "<song>"` at the skip.
- Later, `refuse "<song>" ...: skipped earlier` or `skip candidate ...: skipped earlier` whenever something tries to bring the song back.

## 4. The process is killed or frozen and stays dead

**Cause.** The sandbox freezes or kills Node. `supervise.js` only restarted a child that exited, so a frozen or hung process, or a machine reboot, left Fig dead.

**Fix.**

- **Hang.** Fig sends a heartbeat over IPC every 10 s. The supervisor kills and restarts Fig after 90 s without one.
- **Freeze.** When the supervisor's own timer fires more than 60 s late, the machine was paused. Fig is restarted so the gateway and voice reconnect cleanly. Separately, if the gateway is not ready for 3 minutes, Fig exits to be restarted.
- **Reboot or supervisor death.** Nothing inside a process can survive these. `scripts/ensure-running.sh` checks for a live supervisor and a heartbeat under 3 minutes old, and starts or restarts Fig otherwise. Run it from the sandbox's boot hook and from cron every minute. On normal machines, use `deploy/fig.service` (systemd) or `deploy/install-windows-task.ps1` (Windows: runs at boot and is re-checked every 5 minutes).
- **Back into #zzzz.** With `HOME_VOICE_CHANNEL=zzzz`, Fig joins #zzzz on every start, stays there when it's empty (music stops), and goes to people if they're in another channel. A DJ that was on before a crash or restart is picked back up.

## 5. Voice disconnects

`onForcedDisconnect` was supposed to stay out after three disconnects. The count was reset on every successful rejoin, so it could never reach three, and a person who kept disconnecting Fig was fought forever. Strikes now age out after 10 minutes instead of being reset. A single blip always rejoins. Voice rejoin retries fast at first, then every 5 minutes forever. It no longer gives up after 10 tries.

## 6. Logging

Still `appendFileSync` to `logs/fig.log`, never console only. Since Oct 16, everything is logged:

- What people said or typed, what Fig said, posted or replied (`logs/conversation.log` as well). An answer with no channel to post in is still logged as `UNSENT`.
- Whether each utterance was for Fig, and why not (mode, wake name).
- Every Grok call, every tool and action with who asked, arguments, result and time taken.
- Every song step, and `mixer music -> <song>` each time the audio actually going to Discord changes.
- Voice connection and voice state changes, with whether a voice state belongs to this copy or another one.
- Every line carries `host:pid`, so two copies show up as two tags.

Rotation: 50 MB × 5 files (`FIG_LOG_MAX_MB`, `FIG_LOG_KEEP`); `crash.log` at 5 MB. Opus crashes are still logged once, not per packet. Test: `test/logging.test.js`.

## 7. Modes

There are only two modes. In `normal`, Fig needs its wake name every time: no follow-up window, and no unnamed "skip this song". In `conversation`, no name is needed. Every new call, and every restart, starts in normal. Old saved modes (quiet, active, chaos) are read as normal.

## 8. Old songs cut into the current song for 5-10 seconds, then it goes back (Oct 16)

**Cause.** Two copies of Fig were running on the same bot token. Discord only lets a bot user be in voice once, so the copies took the channel from each other in turns. Each rejoin played a few seconds of whatever *that* copy had, which is why old songs cut in. Fig's rejoin delays are 2, 5 and 10 seconds, which matches the 5-10 second cut-ins. In a single copy, a skipped song can't start again: the regression test replays the whole Oct 16 session and checks that no old song is ever started.

**Fix.**

- **Same machine.** Fig now takes a lock per bot token in the system temp folder, not just per folder. A second copy, even from another checkout, refuses to start: it exits with code 64, and the supervisor does not restart it.
- **Another machine.** Every voice state says which gateway session owns it. When Fig sees its own bot user in voice under a session that isn't its own, another copy has the channel. This copy steps aside: it drops its connection without sending "leave", which would kick the other copy out. It stops rejoining and stays silent, so it doesn't answer commands or mentions. It posts once in chat: "Another copy of Fig is running on this bot token… This copy (host, pid, code version) is stepping aside." When the other copy leaves voice, this copy becomes active again.
- `/status` shows "This copy: host pid code-version", so you can tell which copy is answering.

- **Any machine, no voice needed.** When a slash command fails with "already acknowledged", another program on this token answered it first. Fig logs `ANOTHER COPY:` and says so in chat (at most every 10 minutes).

**Oct 17, 02:15-02:17, proof from the log.** Let Go was skipped and its download killed (`dead id=1 … live=0`). Christmas started and the mixer reported Christmas every 5 seconds through 02:18. Let Go was still heard at 02:17. The audio came from a process that wasn't this one. That process had its own queue and its own log file, which is why fig.log never showed it.

**What other bots ran into (web search, Oct 20).** Searching for similar reports turned up these causes:

- A Bot Maker user had "already acknowledged" errors from five processes running on one token. They went away when the extra processes were stopped.
- In discord.py #9634 (voice not working after connect), a maintainer suspected two running instances and suggested resetting the token "to be certain". Nobody confirmed the cause.
- Other bots' bugs: an old audio player still subscribed, or a callback from a finished track moving the queue along (discord.js #2443). Fig has one mixer and one audio player per server, and a skipped request can't restart. The `on air` lines and the `BUG:` checks now prove both from the log.
- OpenClaw (#172648) passed other users' voice updates into @discordjs/voice 0.19.2, which muted the bot and moved it between channels. Fig uses discord.js's own adapter (`guild.voiceAdapterCreator`), which only passes on the bot's own updates.
- @discordjs/voice 0.19.2 is the newest release. Its DAVE fixes (#11419) are about receiving audio, not sending.

**The sure fix: reset the bot token.** Discord Developer Portal → the app → Bot → Reset Token. Put the new token only in the `.env` of the one copy that should run. Every other copy, wherever it is, is logged out for good.

**Oct 21: it happened again after the token reset and a fresh deploy.** The host's page showed one supervisor and one bot on its machine. That count only covers that one machine. A host with a Publish button usually runs the app twice: once in the workspace or preview, and once as the published deployment. Some hosts also run several replicas. Every copy reads the same `.env`, so a token reset doesn't separate them. To catch this from any machine, Fig now also checks each message its bot account posts. If a message appears that this copy never sent (a "Now playing" line, a slash-command reply), another copy sent it. The live log page (README "Live log page") shows the result in the "Other copies" card, and the `on air` view shows what this copy was really sending at the moment of a cut-in.

**If you see the "another copy" message:** find and stop the other copy. On the sandbox: `ps aux | grep -E "node .*(supervise|index|fig-worker)" | grep -v grep`. Also check for an old website deployment that still has the bot token.

## 9. A queued song disappeared when a different song was skipped (Oct 16)

**Cause.** "Anamanaguchi featuring Hatsune Miku" was queued while "Hatsune Miku Miku" played. Skipping the second song also dropped the first from the queue, because the skip memory matched the two-word request "Hatsune Miku" against anything featuring Hatsune Miku. That's why it had to be asked for twice.

**Fix.**

- Descriptions of one or two words must now match exactly. Track numbers like "11/13" no longer count.
- Songs someone asked for are only dropped or blocked when they are plainly the skipped song: the same upload, or the same title. Sharing an artist or uploader no longer counts, and neither do loose typed words.
- When a skip does remove a queued duplicate, Fig says so in chat.

## 10. Music dipped, came back, then dipped again before Fig answered (Oct 22)

**Cause.** When Fig started on a spoken request it lowered the music for a fixed 1.5 s. Asking Grok and making the voice usually takes 2-4 s, so the music came back up, then dipped again when Fig spoke.

**Fix.** The music now stays down from the moment Fig starts on the request until the answer has been spoken, or until Fig decides to say nothing (`Mixer.duckFor`, with a 15 s safety limit). Test: `test/duck.test.js`.

## 11. "Fig" heard as "fake" or "fix" (Oct 22)

**Cause, part 1.** xAI's speech-to-text reads its options (model, language, `keyterm` hints) only when they come before the audio in the upload. Fig sent the audio first, so the "Fig" hint was probably ignored.

**Fix.**

- The audio is now the last field.
- The hints are "Fig", "Hey Fig", "Okay Fig" and the short commands (skip, pause, resume, stop, queue, shuffle, volume, louder, quieter, DJ).
- Add your own with `STT_KEYTERMS`.
- Test: `test/stt.test.js`.

Next steps (planned): log what Fig thought each command was, and accept near-misses like "hey fix, skip" for simple commands only.

## Already decided (still true)

- One bot, one token. A second copy refuses to start, and a copy on another machine makes this one step aside.
- Voice play requests queue. They never replace the current song.
- No YouTube. SoundCloud is the audio source and Spotify is the lookup.
- Two modes. Normal requires the wake name.
- One voice disconnect is not "stay out forever".
- Opus `memory access out of bounds` is caught and not logged on every packet.
