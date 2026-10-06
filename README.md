# Fig

Fig is a friend in your Discord voice channel. Say "hey Fig", and it plays what you asked for, runs a DJ in the mood you name, answers questions, looks at screenshots, and talks back only to the person who spoke to it. Grok (xAI) is the brain: chat, speech-to-text, text-to-speech, vision and web search.

Reliability comes before features. The sound in the channel is the product.

## What it needs

| Thing | Why | Windows install |
|---|---|---|
| Node.js 22.12+ | runs Fig | `winget install OpenJS.NodeJS.LTS` |
| ffmpeg | decodes music and speech | `winget install Gyan.FFmpeg` |
| yt-dlp | finds and downloads music | `winget install yt-dlp.yt-dlp` |
| deno | yt-dlp needs a JS runtime for YouTube | `winget install DenoLand.Deno` |
| Discord bot token | the bot account | see below |
| xAI API key | Grok | console.x.ai |

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

- "Hey Fig, play Mr. Brightside." If a song is already playing, it goes in the queue.
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

After Fig answers you, you have a few seconds to follow up without saying its name. Nobody else gets that window.

### Chattiness (`/mode`)

| Mode | Fig responds to |
|---|---|
| conversation | anything; no wake name needed |
| quiet | only when named |
| normal (default) | named, or a clear music ask like "skip this song" or "play ..." |
| active | normal, plus the occasional relevant chime-in |
| chaos | acts like another person in the call |

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
| Two uploads of the same title are two songs | Tracks are identified by source id (`youtube:<videoId>`), never by title. Queue entries get their own ids. |
| Volume starts quiet | `DEFAULT_VOLUME=20`, with loudness normalization so songs sit at the same level |
| Talks only to who spoke | Wake-name check on every transcript, a follow-up window for that one person, and replies addressed to them |
| Recovers if the call drops | Voice reconnect with backoff, crash supervisor, and resume-from-position if a stream dies mid-song |

## Troubleshooting

- **"YouTube wants a sign-in check"**: export `cookies.txt` from a logged-in browser and set `YTDLP_COOKIES=C:\path\cookies.txt`.
- **Songs fail after YouTube changes something**: update yt-dlp with `winget upgrade yt-dlp.yt-dlp` or `yt-dlp -U`.
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
