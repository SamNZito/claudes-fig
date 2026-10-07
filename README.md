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
- **Fig doesn't hear anyone**: make sure it isn't server-deafened, check that `LISTEN=true`, and look for "STT failed" in the console. You need to say the wake name unless you're in conversation mode.
- **Grok model errors**: `npm run doctor` lists the models your key can use. Set `GROK_MODEL` to one of them.
- More detail: `LOG_LEVEL=debug`.

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
