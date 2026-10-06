# What is broken

Fig is the Discord voice bot in this repo (Jit#3217, guild Super Chill, channel #zzzz). One process: `node scripts/supervise.js` -> `src/index.js`. Do not run a second Discord client on the same token. The old website worker was removed for that reason.

Logs when it is running: `logs/fig.log` (activity) and `logs/crash.log` (starts, kills, voice). Neither is committed. `.env` is not committed. Copy `.env.example`.

## 1. YouTube audio does not download from the host

Every request starts on YouTube and dies in a few seconds. ffmpeg reports `Invalid data found when processing input`. The bot labels that age-restricted, no audio format, or a sign-in check. One request then walks four or five more YouTube ids before SoundCloud. The call hears "Loading" the whole time.

Observed ids that failed this way: YouTube `7Rv3wfwIVBc`, `31nKmCYYoVk`, `t0FhBzUg0GI`, `dpnJspHEGAs`, `JxHVN05VwIk`, `ZnDmmiiFSUU`, `nIhs1T7OcZg`, `N_OG8CyKXO0`, `6scK5HLdh1o`, `R_vmuL0gjU0`.

Either make YouTube downloads work, or stop trying YouTube first.

## 2. SoundCloud fallback is often a 30 second preview, then silence

`soundcloud:255870455` ("Please Come Home for Christmas (2013 Remaster)") started and about 30s later the player logged `startNext why=ended nothing to play`. The queue was empty, so playback stopped. A volume change happened during that window. `set_volume` only changes `mixer.volumeTarget`. It did not stop the track. The short file ended and was treated as a finished song.

Other SoundCloud copies then failed as DRM: `soundcloud:919898386`, `252876256`, `297283905`.

A play that stops before a minute must be treated as a bad file and replaced with a full-length copy, not as "song over."

## 3. A skipped song plays again

Skip, and the skipped song or an earlier DJ song starts again. Causes in this code:

- Early-end and stall handling in `src/music/player.js` call `_startEntry` on the same entry.
- Fallback starts another upload of the same title after a skip.
- DJ refill used to enqueue while a start was already in progress.
- DJ memory is source id plus a loose title key, so a SoundCloud upload of a skipped YouTube song does not match.
- Voice `play_music` used to pass `when:"now"`, which cut off the current song. `src/brain/tools.js` now forces `queue` or `next`. Only `skip_song` may interrupt.

There is a 30-minute skip block (`_blockSong` / `_skipBlocked`). Do not trust it until a skip in the log shows the next start was refused.

## 4. The process is killed and does not come back

`crash.log` repeatedly says the previous process disappeared with no shutdown line. That is the machine killing Node. `scripts/supervise.js` only restarts a process that actually exits. A freeze or a reboot does not. One gap was about 18 hours: the 20s heartbeat in `src/index.js` was not written, so the event loop was stuck or the process was frozen.

## 5. Voice disconnect used to mean "stay out"

A voice-state clear called `onForcedDisconnect` and Fig refused to rejoin. `src/voice/session.js` now rejoins unless that happens three times. Do not make a single blip permanent.

## 6. Logging was empty when we needed it

`src/log.js` writes with `appendFileSync` because stdout is block-buffered when it is not a TTY. Do not switch that back to console only.

## Already decided

- One bot, one token.
- Voice play requests queue. They do not replace the current song.
- One voice disconnect is not "stay out forever."
- Opus `memory access out of bounds` must be caught and not logged on every packet.
