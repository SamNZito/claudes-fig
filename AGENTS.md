# Instructions for the coding agent (Grok Build or similar)

You are setting up and running **Fig**, a Discord voice bot (Node.js). The code is complete and tested offline. Your job is to install it, configure it, verify it and run it. Don't rewrite it.

## Run it

1. Check the tools: `node -v` (needs 22.12+), `ffmpeg -version`, `yt-dlp --version`, `deno --version`.
   - On Windows, install anything missing with `powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1`.
   - On Linux: `apt install ffmpeg`, `pipx install yt-dlp` (or `pip install -U yt-dlp`), and deno from deno.land.
2. `npm install`
3. Create `.env` from `.env.example`. Ask the user for `DISCORD_TOKEN` and `XAI_API_KEY`. Never print them, and never commit `.env`.
4. `npm test`. All tests must pass. They need no network.
5. `npm run doctor -- "daft punk one more time"`. Fix every FAIL it reports, and it tells you how. If it warns that `GROK_MODEL` isn't available, set it to a model from the list it prints.
6. `npm start`. Leave it running. The console prints an invite link. Give it to the user if Fig isn't in their server yet.

## Rules if you change anything

These are product requirements. Keep them true:

- Never report a song as playing unless audio is actually going out. That is the `started` event in `src/audio/trackSource.js`.
- Skip must destroy the old source (processes and buffer) before the next song starts. Keep the Discord stream `highWaterMark` at 2 in `src/audio/mixer.js`.
- User pause lives only in `MusicPlayer.paused` / `Mixer.musicPaused`. Speech, reconnects and DJ must never clear it.
- Tracks are identified by `key` (source id), never by title.
- Voice commands and slash commands must both go through `src/actions.js`.
- Grok stays the model for talk, speech-to-text, text-to-speech and vision (`src/brain/grok.js`).
- Run `npm test` after any change.

## If something breaks at runtime

- Music fails with "sign in to confirm" / 403: update yt-dlp, make sure deno is installed, or set `YTDLP_COOKIES`.
- xAI 400 errors: the client already drops unsupported optional params on its own. Check `GROK_MODEL`.
- Voice receive errors mentioning DAVE/decrypt: update `@discordjs/voice` to the latest 0.19.x/0.20.x and `@snazzah/davey`, then re-run the tests.
