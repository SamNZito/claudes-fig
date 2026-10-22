# Fig

Fig is a friend in your Discord voice channel. Say "hey Fig", and it plays what you asked for, runs a DJ in the mood you name, answers questions, looks at screenshots, and talks back only to the person who spoke to it. Grok (xAI) is the brain: chat, speech-to-text, text-to-speech, vision and web search.

Reliability comes before features. The sound in the channel is the product.

## What it needs

| Thing | Why | Windows install |
|---|---|---|
| Node.js 22.12+ | runs Fig | `winget install OpenJS.NodeJS.LTS` |
| ffmpeg | decodes music and speech | `winget install Gyan.FFmpeg` |
| yt-dlp | downloads music from SoundCloud | `winget install yt-dlp.yt-dlp` |
| Discord bot token | the bot account | see below |
| xAI API key | Grok | console.x.ai |
| Spotify app keys (optional, recommended) | exact song lookup and Spotify links | developer.spotify.com |

On Windows, `setup-windows.ps1` installs all of it, runs `npm install`, creates `.env` and runs the checks:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1
```

## Discord setup (once)

1. Go to discord.com/developers/applications, click **New Application**, and name it Fig.
2. Open **Bot**, click **Reset Token**, and put the token in `.env` as `DISCORD_TOKEN`. Fig does not need any privileged intents.
3. Start Fig once. The console prints an **invite link** with the permissions it needs. Open it and add Fig to your server.
4. Fig's role needs to sit above the people it should be able to kick, ban, time out or mute.

## Run

```
npm install
copy .env.example .env      (then fill in DISCORD_TOKEN and XAI_API_KEY)
npm run doctor -- "daft punk one more time"
npm start
```

`npm start` runs Fig under a small supervisor that restarts it if it ever crashes. `npm test` runs the test suite, which needs no Discord or xAI access.

## Talking to Fig

Say the wake name (default **Fig**) anywhere in the sentence:

- "Hey Fig, play Mr. Brightside." If a song is already playing, it goes in the queue. You can also paste a Spotify or SoundCloud link into `/play`.
- "Fig, play Dreams by Fleetwood Mac next."
- "Fig skip." / "Fig pause." / "Fig resume." / "Fig stop." / "Fig clear."
- "Fig turn it down." / "Fig volume 30."
- "Fig, take song 3 out of the queue."
- "Fig, DJ something like late-night lo-fi." / "Fig, change the mood to 2000s pop punk." / "Fig, DJ off."
- "Fig, be a zombie." / "Fig, be a pirate who hates jazz." / "Fig, switch your voice to Rex."
- "Fig, say happy birthday Sam."
- "Fig, stop talking." / "Fig, forget that." / "Fig, what are you doing?"
- "Fig, set a timer for 10 minutes for pizza."
- "Fig, who won the game last night?" (web lookup)
- Someone makes a claim, then: "Fig, fact-check that."
- "Fig, time out Jordan for 5 minutes." Bans need a spoken "yes" first.

### Modes (`/mode`)

There are two modes:

| Mode | Fig responds to |
|---|---|
| normal (default) | only when you say its name. Without the name, nothing happens, including follow-ups and music commands. |
| conversation | anything said in the call; no name needed |

Every new call starts in normal mode, including after a restart. Say "Fig, conversation mode" or use `/mode` to switch. A reconnect after a call blip keeps the current mode.

### Slash commands

`/join` `/leave` `/play` `/skip` `/remove` `/pause` `/resume` `/stop` `/clear` `/shuffle` `/queue` `/nowplaying` `/volume` `/dj on|off|mood` `/mode` `/name` `/personality preset|custom|show` `/voice set|list` `/say` `/shutup` `/forget` `/status` `/timer` `/ask` `/look` `/factcheck` `/mod` `/access allow|disallow|reset|show`

You can also @mention Fig in any text channel with a question or a screenshot.

### Who can do what (`/access`)

Three capabilities, each limited to roles you choose. With no roles set, everyone can use it. Members with Manage Server can always do everything.

- **ask**: talk to Fig and request songs
- **control**: skip, pause, stop, clear, volume, and change Fig's mode, name, personality and voice
- **dj**: turn DJ on or off and change its mood

Moderation (`/mod`, or asking by voice) also requires the matching Discord permission, such as Kick Members or Moderate Members.

## How the brief maps to the code

| Brief | How |
|---|---|
| You ask for a song and hear that song | `music/search.js` → `audio/trackSource.js` (yt-dlp → ffmpeg → PCM) → `audio/mixer.js` → Discord |
| Never pretend a song is playing | "Now playing" is only posted when the mixer actually pulls audio from the song (`started` event). A song that yields no audio within 30 s, or errors, is reported and skipped. |
| Skip means the song is gone | Skip kills yt-dlp/ffmpeg and drops the buffered audio. Only about 2 packets (40 ms) are buffered downstream, so the next thing you hear is the next song. The skipped song goes into memory, so the DJ won't pick it again. |
| Pause stays paused | Pause is a flag on the music lane only. Fig's speech plays on its own lane, and a call blip only stops frames being pulled, so neither one can unpause music. |
| Music ducks while Fig talks | Music dips to `DUCK_LEVEL` under speech, and while the person Fig is talking with speaks. Set `DUCK_MODE=wait` to hold the music instead. |
| DJ has a memory | `data/guild-<id>.json` keeps the last 400 plays by source id. The DJ skips those and near-duplicates of recent titles. Your own requests are never blocked. |
| Two uploads of the same title are two songs | Uploads are identified by source id (`soundcloud:<id>`), never by title. Queue entries get their own ids. |
| Volume starts quiet | `DEFAULT_VOLUME=20`, with loudness normalization so songs sit at the same level |
| Talks only to who spoke | In normal mode, nothing happens without the wake name. Replies are addressed to the person who spoke. |
| Recovers if the call drops | Voice reconnect with backoff, crash supervisor, and resume-from-position if a stream dies mid-song |

## Keeping Fig up

`npm start` runs Fig under `scripts/supervise.js`. The supervisor restarts Fig when it crashes, when it hangs (no heartbeat for 90 s), and when the machine was frozen. It also refuses to run two copies, because two clients on one token kick each other out of voice.

The supervisor can't restart itself after a reboot, so something outside has to start it:

- **Windows PC:** `deploy/install-windows-task.ps1` (admin PowerShell). It starts Fig at boot and re-checks every 5 minutes. Also turn off sleep.
- **Linux:** `deploy/fig.service` (systemd).
- **Sandbox or container:** run `scripts/ensure-running.sh` from the startup hook and from cron every minute.

Set `HOME_VOICE_CHANNEL=zzzz` and Fig goes back to #zzzz after every restart. It picks the DJ back up if the DJ was on.

## Where the music comes from

**Audio comes from SoundCloud. YouTube is not used.** Spotify is used to find songs, not to play them: Spotify audio is DRM-locked and no bot can stream it.

1. **Lookup.** With Spotify keys set, "play please come home for christmas" is looked up on Spotify first, which gives the real artist, title and length ("Eagles - Please Come Home for Christmas", 2:58). Spotify track and album links work the same way, and a track link works even without keys. Spotify won't hand out playlist contents to bots (since February 2026), unless the playlist is owned by the app's account.
2. **Audio.** Fig searches SoundCloud for that artist and title and probes each copy before it plays. It skips 30-second previews, DRM-locked copies, and copies whose length doesn't match Spotify's (edits, previews, wrong songs). A copy that still stops early is swapped for another one.
3. **Not found.** If SoundCloud only has previews or locked copies, Fig says so instead of going quiet. This happens for some major-label songs, because labels often post only previews there.

A pasted YouTube link is only used for its title, and the song is then found on SoundCloud.

A skipped song is gone. No other upload of it, no DJ pick, and no queued duplicate plays for `SKIP_BLOCK_HOURS` (6 by default), even across restarts. Asking for it again on purpose works.

`npm run doctor -- "song name"` tests the whole path from the machine Fig runs on.

## Troubleshooting

- **"SoundCloud only has previews or locked copies"**: that song isn't fully on SoundCloud. Try another version, or a remix.
- **Downloads start failing everywhere**: update yt-dlp with `winget upgrade yt-dlp.yt-dlp` or `yt-dlp -U`.
- **Fig doesn't hear anyone**: make sure it isn't server-deafened, check that `LISTEN=true`, and look for "STT failed" in `logs/fig.log`. You need to say the wake name unless you're in conversation mode.
- **Grok model errors**: `npm run doctor` lists the models your key can use. Set `GROK_MODEL` to one of them.
- More detail: `LOG_LEVEL=debug`.

## Logs

Everything goes to files in `logs/`, written line by line so nothing is lost if Fig is killed:

- `logs/fig.log`: everything. Every line has the time, level, `host:pid` (which copy of Fig wrote it) and a `[scope]`.
- `logs/conversation.log`: only what was said: `HEARD` (speech, after transcription), `TYPED` (mentions), `SLASH` (slash commands), `SAID` (spoken by Fig), `POSTED` / `REPLY` (Fig's chat messages), `UNSENT` (an answer Fig had nowhere to post).
- `logs/crash.log`: starts, exits, kills, freezes and gateway drops (also copied into fig.log).

What fig.log covers, by scope:

| Scope | What |
|---|---|
| `talk` | the same lines as conversation.log |
| `brain` | each utterance: who, transcription time, whether it was for Fig and why (mode, wake name) |
| `grok` | every xAI call (endpoint, model, status, time) and which tools Grok picked |
| `tool` | every tool Grok used, with arguments and result |
| `action` | every action (play, skip, pause, volume, dj, moderate…): who asked, from where, arguments, result, time taken |
| `player`, `resolve`, `track`, `spotify`, `dj` | every song: request, lookup, copies tried, download start, first audio, end (`played=Xs of Ys`), skips and blocks |
| `session` | voice connection changes, audio player state, `mixer music -> <song>` (what is actually being sent to Discord), TTS |
| `index`, `instance`, `supervise`, `moderation`, `crash` | startup, which copy is running, voice states of Fig's own user, standby, restarts, moderation actions |

Logs rotate at `FIG_LOG_MAX_MB` (50) and keep `FIG_LOG_KEEP` (5) old files.

**Two songs alternating?** Every 15 s while music plays, fig.log has an `on air: "<song>" sent Ns, voice=… subscriptions=…` line: what this copy is really sending. If people heard a song that isn't in those lines, the audio came from another program (another Fig copy on the token, or another bot in the channel; check whose avatar lights up green). `BUG:` lines mean this copy has two sessions or two audio subscriptions for one server. Also search for `mixer music ->`. If one `host:pid` switches between two songs, it's a bug in that copy. If there are no such lines for the cut-in, or there are `FOREIGN` voice states or `STANDBY` lines, another copy of Fig is on the token (PROBLEMS.md §8).

## Control panel

`npm run panel` serves the page to keep open on the host:

- **Token:** paste a new bot token once. It is saved to `data/discord-token` (owner-only, never shown again, never put in the environment), and Fig starts with it. A token saved here wins over `DISCORD_TOKEN` in `.env`.
- **Start:** when a token is already saved, just press Start. **Stop** and **Restart** are there too. Stop stays stopped: the every-minute `ensure-running.sh` check, boot hooks and the supervisor itself won't start Fig again until Start is pressed.
- **This copy:** how many supervisors, bots and strays are running on this machine, plus the last heartbeat.
- **Live log:** shown right on the panel, and full-page at `/logs`. The panel reads the log files itself, so the log is there even while Fig is stopped or crashing. Fig's live status (what's on air, other copies) comes from Fig on 127.0.0.1. Nothing is put in a frame, because many hosts refuse frames (Chrome shows `ERR_BLOCKED_BY_RESPONSE`). New lines arrive by polling every 2 s, which works through any host's proxy.

The panel is its own small process, so it stays up while Fig is stopped or restarting. It listens on `$PORT` if the host sets one, otherwise on 127.0.0.1:8080. Anywhere but 127.0.0.1 it needs `FIG_PANEL_KEY`: it asks for the key once, then remembers it in a cookie.

## Live log page

Fig serves its own page: **http://127.0.0.1:8790/** on the machine it runs on (`FIG_WEB_PORT`).

- **Other copies:** green when there's no sign of another program on the bot token. It turns red the moment Fig catches one in any of three ways:
  - Its bot account shows up in voice under a gateway session that isn't its own.
  - A slash command was already answered when this copy tried to answer it.
  - A message from the bot account appears that this copy never sent.
- **This copy:** machine, process, code version, uptime, Discord connection.
- **Each server:** voice channel, what is **on air** right now (what this copy is actually sending), the request, the queue, the player, mode and volume.
- **Live log:** tabs for Everything, Talk, Music, On air, Problems and Copies, plus search and a choice of fig.log, conversation.log or crash.log. New lines stream in as they're written.

The JSON is also available directly: `/api/status`, `/api/logs?view=onair&q=let%20go`, `/api/stream`.

The logs contain what people said, so the page only listens on 127.0.0.1 by default. To open it from elsewhere, or to show it inside a hosted page, set `FIG_WEB_HOST=0.0.0.0` and `FIG_WEB_KEY=<secret>`, then open `/?key=<secret>`. Without a key, Fig refuses to listen beyond the machine.

## Layout

```
src/
  index.js              Discord client, auto-join/leave, mentions
  config.js / store.js  settings (.env) and per-server saved state
  actions.js            everything Fig can do; used by voice AND slash commands
  audio/                mixer (music + speech lanes), track source, TTS, opus
  music/                queue, player, search, DJ
  voice/session.js      one per server: connection, reconnects, speaking
  voice/listener.js     hears people, cuts utterances, makes WAV for STT
  brain/                Grok client, wake name, modes/routing, tools, personalities, memory
  discord/              slash commands, permissions, moderation
scripts/doctor.js       checks setup
scripts/supervise.js    auto-restart
test/                   runs offline with a fake yt-dlp
```
