# Problems and what was done about them

Fig is the Discord voice bot in this repo (Jit#3217, guild Super Chill, channel #zzzz). It runs as one process: `node scripts/supervise.js`, which runs `src/index.js`. Do not run a second Discord client on the same token. The old website worker was removed for that reason, and Fig now refuses to start a second copy of itself.

Logs while it runs are `logs/fig.log` (activity, rotated at 25 MB) and `logs/crash.log` (starts, kills, freezes, voice events). Neither is committed, and neither is `.env`. Copy `.env.example` to make one.

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

Unchanged on purpose: `appendFileSync` to `logs/fig.log`. Added rotation at 25 MB (`fig.log.1`) and at 5 MB for `crash.log`.

## 7. Modes

There are only two modes. In `normal`, Fig needs its wake name every time: no follow-up window, and no unnamed "skip this song". In `conversation`, no name is needed. Every new call, and every restart, starts in normal. Old saved modes (quiet, active, chaos) are read as normal.

## Already decided (still true)

- One bot, one token. A second copy refuses to start.
- Voice play requests queue. They never replace the current song.
- No YouTube. SoundCloud is the audio source and Spotify is the lookup.
- Two modes. Normal requires the wake name.
- One voice disconnect is not "stay out forever".
- Opus `memory access out of bounds` is caught and not logged on every packet.
