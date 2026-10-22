# Instructions for the coding agent (Grok Build or similar)

You are setting up and running **Fig**, a Discord voice bot (Node.js). The code is complete and tested offline. Your job is to install it, configure it, verify it and run it. Don't rewrite it.

## Run it

1. Check the tools: `node -v` (needs 22.12+), `ffmpeg -version`, `yt-dlp --version`, `deno --version`.
   - On Windows, install anything missing with `powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1`.
   - On Linux: `apt install ffmpeg`, `pipx install yt-dlp` (or `pip install -U yt-dlp`), and deno from deno.land.
2. `npm install`
3. Create `.env` from `.env.example`. Ask the user for `DISCORD_TOKEN` and `XAI_API_KEY`, and for `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` (optional, recommended). Never print them, and never commit `.env`.
4. `npm test`. All tests must pass. They need no network.
5. `npm run doctor -- "daft punk one more time"`. Fix every FAIL it reports, and it tells you how. If it warns that `GROK_MODEL` isn't available, set it to a model from the list it prints.
6. Make sure no other copy of Fig is running anywhere on this bot token: `ps aux | grep -E "node .*(supervise|index|fig-worker)" | grep -v grep`. Also check old deployments, such as a website worker. Two copies fight over voice and make old songs cut in.
7. Start it so that it comes back on its own. Do not just run `npm start` in a terminal that goes away:
   - In a sandbox or container: make the boot or startup hook run `scripts/ensure-running.sh`, and also run it every minute (cron: `* * * * * /path/scripts/ensure-running.sh`). It starts Fig if it isn't running and restarts it if it is frozen. Running it twice is safe.
   - On Linux with systemd, use `deploy/fig.service`.
   - On Windows, run `deploy/install-windows-task.ps1` in an admin PowerShell.
8. Set `HOME_VOICE_CHANNEL=zzzz` in `.env` so Fig always goes back to #zzzz.
9. Read `PROBLEMS.md`. It explains each past failure and which log line proves it's fixed.
10. **The page you host is Fig's control panel: `npm run panel`.** Don't build your own token page. The panel has:
    - the token box,
    - a **Start** button for when the token is already saved,
    - Stop and Restart,
    - the process counts,
    - the live log.
    Set `FIG_PANEL_KEY` and give that key to the user. The panel listens on `$PORT`. Keep the panel itself always running (that's what the host's "run" should be). The panel starts Fig.
    If you also keep `scripts/ensure-running.sh` in cron, that's fine: it respects Stop.
    The panel shows the live log itself: it reads `logs/` from disk and asks Fig for status on `127.0.0.1:8790`. Full page: `/logs`. Leave `FIG_WEB_HOST` at 127.0.0.1. Don't put the panel or the log in an iframe: the host refuses frames (ERR_BLOCKED_BY_RESPONSE).
11. Make sure your host runs Fig **once**. Run the panel only in the published deployment, and don't run Fig or the panel in the workspace or preview at the same time. A workspace or preview run plus a published deployment, or more than one replica or instance, are two copies on one token, even after a token reset, because each one reads the same `.env`. Run it in exactly one place, set replicas to 1 and turn off autoscaling. The page's "Other copies" card turns red if a second copy exists anywhere.
12. When something goes wrong, read `logs/fig.log` (everything) and `logs/conversation.log` (what was said). README "Logs" explains the lines.

## Rules if you change anything

These are product requirements. Keep them true:

- Never report a song as playing unless audio is actually going out. That is the `started` event in `src/audio/trackSource.js`.
- A queue entry is a request. Copies are picked by `src/music/resolve.js` (probe first, previews and DRM rejected). Never restart, re-queue or re-search a request from outside `MusicPlayer`. Every async continuation must check `entry.cancelled`.
- Skip blocks the SONG (`src/music/identity.js`), not just the upload. Don't weaken this to id-only matching.
- One "blocked" probe marks the whole source down (`src/music/sources.js`). Don't loop over more uploads from a refused source.
- Never start a second Discord client on the token. `supervise.js` and `index.js` both refuse to.
- Logging stays `appendFileSync` (`src/log.js`), and everything stays logged: what was heard and said (`conversation()`), every action (`traceAll` in `src/actions.js`), every Grok call, every song step. New code that does something logs it.
- Skip must destroy the old source (processes and buffer) before the next song starts. Keep the Discord stream `highWaterMark` at 2 in `src/audio/mixer.js`.
- User pause lives only in `MusicPlayer.paused` / `Mixer.musicPaused`. Speech, reconnects and DJ must never clear it.
- Tracks are identified by `key` (source id), never by title.
- Voice commands and slash commands must both go through `src/actions.js`.
- Grok stays the model for talk, speech-to-text, text-to-speech and vision (`src/brain/grok.js`).
- Run `npm test` after any change.

## If something breaks at runtime

- Do not add YouTube back. Audio comes from SoundCloud, and Spotify is only used for lookup. The user decided this.
- Only two modes: `normal` (wake name required, nothing else gets through) and `conversation`. Every new call starts in normal.
- Songs fail with "only previews or locked copies": that song isn't fully on SoundCloud. That's expected for some songs and is not a bug. `npm run doctor -- "song"` shows the whole path.
- xAI 400 errors: the client already drops unsupported optional params on its own. Check `GROK_MODEL`.
- Voice receive errors mentioning DAVE/decrypt: update `@discordjs/voice` to the latest 0.19.x/0.20.x and `@snazzah/davey`, then re-run the tests.
