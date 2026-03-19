# Webrig

A general-purpose Electron browser with audio routing capabilities. It loads any web page in a full Chromium window and can stream that window's audio out to a Discord voice channel.

## What it is

At its core this is a controllable browser window:
- Loads any URL (YouTube, SoundCloud, voice calls, anything)
- Runs on Chromium, compatible with sites that expect a modern Chrome browser
- Controllable via Chrome DevTools Protocol (CDP) on port 9229 — use `agent-browser` to automate it
- Navigation bar lets you change URLs on the fly

The Discord integration is one output channel — audio captured from whatever is playing in the window gets streamed into a Discord voice channel via a bot.

## How It Works

1. Electron opens a BrowserWindow loading `TARGET_URL`
2. A Web Audio API tap intercepts all audio playing in the window (video elements, audio contexts, everything)
3. Audio is encoded to Opus and streamed to a Discord voice channel via a bot token
4. The window's local audio output is muted — audio only goes to Discord

## Prerequisites

- Node.js 18 or later
- A Discord bot token with CONNECT and SPEAK permissions in the target voice channel

## Installation

```
git clone <repo>
cd webrig
npm install --legacy-peer-deps
cp .env.example .env
```

Edit `.env` with your values.

## Configuration (.env)

| Variable | Description |
|---|---|
| DISCORD_BOT_TOKEN | Discord bot token |
| TARGET_URL | URL to load on startup |
| GUILD_ID | Discord server ID |
| CHANNEL_ID | Voice channel ID to join |
| CDP_PORT | CDP debug port (default: 9229) |

To get Guild ID and Channel ID: enable Developer Mode in Discord settings, then right-click the server/channel and select "Copy ID".

## Running

```
npm start
```

Or with PM2:

```
pm2 start ecosystem.config.cjs
```

## CDP / Agent Browser Control

The window exposes CDP on `127.0.0.1:9229`. Use [agent-browser](https://github.com/vercel-labs/agent-browser):

```
agent-browser snapshot
agent-browser open https://example.com
agent-browser screenshot
```

`~/.agent-browser/config.json` sets `{"cdp": "9229"}` as default so no flag is needed.

## Building

```
npm run build
```

Produces a Windows NSIS installer at `dist/Webrig Setup x.x.x.exe`.

Releases are also built automatically on every push to master at [AnEntrypoint/webrig](https://github.com/AnEntrypoint/webrig/releases).
