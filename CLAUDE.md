# Jerryrig — Architecture

## System Overview

Single Electron process that:
1. Opens a BrowserWindow loading TARGET_URL
2. Runs a discord.js v14 bot client (official bot token) in the main process
3. Joins a Discord voice channel via @discordjs/voice
4. Captures the Electron window audio via MediaElementSource / MediaStreamDestination tap on all AudioContexts (in preload context)
5. Pipes raw PCM Float32 → interleaved s16le → prism-media Opus encoder → AudioResource → Discord voice
6. Receives Discord voice audio → VoiceReceiver Opus stream → prism-media Opus decoder → PCM Float32 → IPC → Web Audio API playback

## Audio Flow

### Outbound (Electron → Discord)
1. Electron window loads TARGET_URL
2. On `did-finish-load`, main sends `start-capture` IPC to renderer
3. Preload patches `window.AudioContext` to intercept all new contexts via `tapPageCtx`
4. `tapPageCtx` creates a MediaStreamDestination tap and patches `AudioNode.prototype.connect` to mirror all connections to `pageCtx.destination` into the tap
5. All `<audio>`/`<video>` elements are tapped via `createMediaElementSource` (with `captureStream` fallback); a MutationObserver and periodic 2s scan catch dynamically added elements
6. ScriptProcessorNode collects all tapped audio, interleaves stereo channels to Float32
7. Sends `audio-pcm` IPC to main with the Float32Array buffer
8. Main process `ipcMain.on('audio-pcm')` calls `pushAudioFrame(f32)`
9. `pushAudioFrame` converts f32 to s16le, writes to PassThrough stream
10. PassThrough → prism opus Encoder → createAudioResource(StreamType.Opus) → AudioPlayer.play()

### Inbound (Discord → Electron)
1. VoiceReceiver detects speaking via `speaking` event
2. `subscribeToSpeaker` subscribes to user's Opus stream
3. prism opus Decoder converts Opus → s16le PCM Buffer
4. Decoded buffer converted to Float32Array (/ 32768)
5. `sendAudioToRenderer` sends `audio-chunk` IPC to renderer
6. Preload AudioContext schedules buffer playback with jitter buffer

## Key Architecture Decisions

### Bot runs in Electron main process
No separate bot process. Eliminates socket/IPC complexity for audio. Bot and Electron share the same Node.js event loop.

### Official bot token (discord.js v14)
Uses `discord.js` v14 with `GatewayIntentBits.Guilds` and `GatewayIntentBits.GuildVoiceStates`. No selfbot. Bot must have CONNECT + SPEAK permissions in the target voice channel.

### Audio capture via desktopCapturer loopback
The preload script uses `getUserMedia` with `chromeMediaSource: 'desktop'` and the window's source ID. This captures both audio and a minimal video stream (1x1 px) to get the audio loopback. The video track is unused; only the audio track is processed.

### PCM pipeline uses ScriptProcessorNode
ScriptProcessorNode (deprecated but universally available in Electron/Chromium) is used in the preload to tap the audio at exactly 960 samples/frame (one Opus frame). This avoids AudioWorklet complexity and works reliably in the preload isolated world.

### preload.js must be .cjs
With `"type": "module"` in package.json, Electron preload scripts must use `.cjs` extension. The main process uses ESM.

### Voice encryption: tweetnacl
@discordjs/voice requires a sodium implementation. `tweetnacl` is used (pure JS, no native build required on Windows). `libsodium-wrappers` also present as fallback.

## Navbar

The navbar is injected by `preload.cjs` using `ipcRenderer` directly. It is NOT injected via `executeJavaScript` from main.js.

### Why not executeJavaScript
`executeJavaScript` runs in the renderer's page context where `require` is undefined. The original `require('electron').ipcRenderer` call inside `navbar.cjs` threw, silently failing injection.

### Why not require('./navbar.cjs') from preload
Electron 31 enables sandbox by default for all renderers. In sandbox mode, `preloadRequire` only allows `require('electron')` — local file requires like `require('./spoof.cjs')` throw `module not found`. `app.disableSandbox()` and `sandbox: false` on the BrowserWindow do not override this in Electron 31.

### Fix
All navbar, spoof, and youtube ad-skip logic is inlined directly in `preload.cjs`. No local `require` calls. The preload uses the already-available `ipcRenderer` from `require('electron')` directly for all IPC sends.

### Preload file size
`preload.cjs` exceeds 200 lines because it inlines three modules (spoof, navbar, audio capture) that cannot be split into separate files due to the sandbox `require` restriction.

## Gotchas

### Guild/channel cache on ready
With discord.js v14, the guild and channel cache may not be populated immediately on `ready`. `joinDiscordVoice` explicitly calls `guilds.fetch()` and `guild.channels.fetch()` if the cache misses.

### AudioPlayer idle after silence
When no audio frames arrive, the AudioPlayer goes idle (resource stream ends or stalls). The `AudioPlayerStatus.Idle` handler calls `_startPlayback()` to reset the PassThrough + encoder pipeline and continue playing.

### AudioContext in preload isolated world
With `contextIsolation: true`, the preload runs in a separate world but has access to Web Audio API. Inbound audio playback goes to system speakers regardless of what page is loaded.

### Audio capture via Web Audio tap (not desktopCapturer)
The preload patches `window.AudioContext` to intercept all page-created contexts. Each context gets a `MediaStreamDestination` tap; `AudioNode.prototype.connect` is patched to mirror connections to destination into the tap. `<audio>`/`<video>` elements are captured via `createMediaElementSource`. A periodic scan every 2s catches elements added after the MutationObserver fires. `display-capture` permission is granted in `setPermissionRequestHandler` but is no longer required for this approach.

## agent-browser (CDP)

The Electron window exposes Chrome DevTools Protocol on `127.0.0.1:CDP_PORT`. The `.env` sets `CDP_PORT=9229` (port 9222 is blocked by Windows firewall/access-control on this machine).

Connect with [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser):

```
agent-browser connect 9229
agent-browser snapshot
agent-browser screenshot
agent-browser --cdp 9229 open https://example.com
```

`/json/version` returns `webSocketDebuggerUrl` with `127.0.0.1` (not `localhost`). This is required on Windows where `localhost` can resolve to `::1` (IPv6) and break CDP WebSocket connections. The `--remote-debugging-address=127.0.0.1` switch in main.js enforces this.

The port is set via `app.commandLine.appendSwitch('remote-debugging-port', CDP_PORT)` before `app ready`. Change it with `CDP_PORT=<port>` in `.env`.

No custom HTTP server is needed — Electron's built-in CDP server is the interface agent-browser uses.

## Hyperswarm Multi-Client Architecture

### Headless CDP client (`src/p2p/client.js`)

A standalone Node.js script (no Electron) that joins the swarm as a peer and exposes a local CDP WebSocket proxy.

```
SWARM_TOPIC=myapp CDP_PROXY_PORT=9230 node src/p2p/client.js
# or:
SWARM_TOPIC=myapp npm run headless
```

Multiple instances can run simultaneously with different `CDP_PROXY_PORT` values. Each connects independently to the host Electron window over hyperswarm.

Connect agent-browser to the proxy port instead of directly to the Electron CDP port:
```
agent-browser connect 9230
```

### Multi-peer swarm (swarm.js)

`swarm.js` uses a `Map<id, {conn, recvBuf}>` to track all connected peers simultaneously. Previously, new connections were rejected when one peer existed. Now all peers are accepted. The `onCdpUp(payload, conn)` callback includes the source connection so the host can route responses back to the correct peer.

### Per-peer CDP server connections (cdp-proxy.js)

On the host side, each swarm peer gets its own WebSocket connection to the Electron CDP server (`peerHostSockets Map<conn, WebSocket>`). CDP responses from the CDP server are routed back to the originating peer via `sendCdpDown(buf, conn)`. This means multiple headless clients can run independent CDP sessions simultaneously.

`onPeerConnect(conn)` and `onPeerDisconnect(conn)` are exported and called from `main.js` to manage the per-peer CDP server connections.

### Gotchas

- Each headless client needs a unique `CDP_PROXY_PORT` if running on the same machine.
- The Electron CDP server supports one session per WebSocket — each peer gets its own upstream connection.
- The swarm host must be running before headless clients join; clients wait for the host via DHT.
- Audio and frame broadcasts go to all connected peers; CDP messages are routed per-peer.

## File Map

- `src/main.js` — Electron main entry, wires all modules
- `src/p2p/swarm.js` — Hyperswarm multi-peer management, framed binary protocol
- `src/p2p/cdp-proxy.js` — CDP proxy: per-peer host connections, multi-client WS server
- `src/p2p/client.js` — Headless CDP client (no Electron), run with `npm run headless`
- `src/p2p/host.js` — Screen capture for P2P relay
- `src/bot/client.js` — discord.js v14 login, @discordjs/voice join, Opus decode, audio IPC send
- `src/bot/voice.js` — PCM PassThrough → Opus encoder → AudioResource → AudioPlayer
- `src/electron/preload.cjs` — Audio playback (Web Audio) + loopback capture (desktopCapturer)
- `src/electron/error.html` — Fallback page if TARGET_URL fails
- `.env.example` — All configurable variables
