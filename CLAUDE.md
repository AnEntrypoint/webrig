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
3. Preload patches `window.AudioContext` to auto-resume all page contexts on creation
4. `buildCaptureGraph()` creates a capture AudioContext + AudioWorkletNode (`capture-processor` from `capture-worklet.js`)
5. `AudioNode.prototype.connect` is patched to mirror any connection to `AudioDestinationNode` into the worklet node
6. All `<audio>`/`<video>` elements are tapped via `createMediaElementSource`; a MutationObserver and periodic 2s scan catch dynamically added elements
7. AudioWorklet posts each 960-sample frame; preload sends it as `audio-pcm` IPC to main
8. Main process `ipcMain.on('audio-pcm')` calls `pushAudioFrame(f32)`
9. `pushAudioFrame` converts f32 to s16le, writes to PassThrough stream
10. PassThrough → prism opus Encoder → createAudioResource(StreamType.Opus) → AudioPlayer.play()

### Inbound (Discord → Electron)
Not implemented in the Electron host. Inbound Discord audio is only bridged in `companion/index.js` (companion mode):
1. VoiceReceiver detects speaking via `speaking` event
2. `subscribeToSpeaker` subscribes to user's Opus stream
3. prism opus Decoder converts Opus → s16le PCM Buffer
4. Decoded buffer converted to Float32Array (/ 32768)
5. Companion sends AUDIO frame to extension over WS (port 9888)

## Key Architecture Decisions

### Bot runs in Electron main process
No separate bot process. Eliminates socket/IPC complexity for audio. Bot and Electron share the same Node.js event loop.

### Official bot token (discord.js v14)
Uses `discord.js` v14 with `GatewayIntentBits.Guilds` and `GatewayIntentBits.GuildVoiceStates`. No selfbot. Bot must have CONNECT + SPEAK permissions in the target voice channel.

### Audio capture via Web Audio intercept + AudioWorklet
The preload patches `window.AudioContext` to auto-resume all page-created contexts. A dedicated capture `AudioContext` is created with an `AudioWorkletNode` (`capture-processor` loaded from `capture-worklet.js`). `AudioNode.prototype.connect` is patched so anything connecting to `AudioDestinationNode` also feeds the worklet. `<audio>`/`<video>` elements are tapped via `createMediaElementSource`. The worklet emits 960-sample frames (one Opus frame) via `port.onmessage` → `ipcRenderer.send('audio-pcm')`.

### PCM pipeline uses AudioWorklet
`AudioWorkletNode` with `capture-processor` (in `src/electron/capture-worklet.js`) handles PCM collection at exactly 960 samples/frame. The worklet runs in the audio rendering thread, avoiding the main-thread overhead of `ScriptProcessorNode`.

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

### Voice join: gateway leave + retry backoff
Before joining, `joinDiscordVoice` sends a gateway voice-leave op (op 4 with `channel_id: null`) and waits up to 5s for Discord to confirm via `voiceStateUpdate` — this clears any stale session. Then it retries up to 8 times with variable backoff: close code 4017 → 10s, 4006 → 8s, anything else → 4s.

### AudioPlayer idle after silence
When no audio frames arrive, the AudioPlayer goes idle (resource stream ends or stalls). The `AudioPlayerStatus.Idle` handler calls `_startPlayback()` to reset the PassThrough + encoder pipeline and continue playing.

### contextIsolation is false on the main BrowserWindow
`main.js` creates the BrowserWindow with `contextIsolation: false`. This means `require('electron')` in the preload is available directly in the page's JS world. Inbound audio playback goes to system speakers regardless of what page is loaded.

### Audio capture via Web Audio tap (not desktopCapturer)
The preload patches `window.AudioContext` to intercept all page-created contexts. Each context gets a `MediaStreamDestination` tap; `AudioNode.prototype.connect` is patched to mirror connections to destination into the tap. `<audio>`/`<video>` elements are captured via `createMediaElementSource`. A periodic scan every 2s catches elements added after the MutationObserver fires. `display-capture` permission is granted in `setPermissionRequestHandler` but is no longer required for this approach.

### WS audio server also runs in Electron host
`main.js` starts a WebSocketServer on `WS_AUDIO_PORT` (default 9888) that accepts raw Float32 binary frames from any local client (same format as the extension sends to companion). This allows the companion to be skipped when only Discord audio bridging is needed.

### host.js uses WINDOW_TITLE to find the window for screen capture
`src/p2p/host.js` calls `desktopCapturer.getSources` every 100ms and matches by `name === 'Discord Voice Bridge'` (the hardcoded `WINDOW_TITLE` constant shared with `main.js`). If the window title changes or no window matches, it falls back to `sources[0]`.

### audio-pcm IPC is also forwarded to swarm peers
When `SWARM_ROLE=host`, each `audio-pcm` frame received from the renderer is forwarded to all connected swarm peers via `swarmMod.sendAudio(f32)` in addition to being pushed to the local AudioPlayer.

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

## Browser Extension Host Mode

The `extension/` directory contains a Chrome extension that can replace the Electron window entirely. It provides the same capabilities (audio relay, screen relay, CDP passthrough, input forwarding) using only a Chrome browser and the extension.

### Framing Protocol

All binary WebSocket messages use the same 4+4+N framing as `src/p2p/swarm.js`:

- Bytes 0–3: message type as LE uint32 (AUDIO=1, FRAME=2, INPUT=5)
- Bytes 4–7: payload length as LE uint32
- Bytes 8+: payload

Audio payload: interleaved stereo Float32Array (48 kHz, 4096-sample frames).
Frame payload: fragmented webm chunks from MediaRecorder (AV1 or H264, 100ms timeslice). Was JPEG; replaced with MediaRecorder for compressed video.
Input payload: JSON string of a CDP Input event (`{ type, ...fields }`).

### Extension Files

- `extension/offscreen.js` — Runs in the offscreen document. Captures tab audio and video via `getUserMedia` with `chromeMediaSource: tab`. Sends AUDIO (type=1) Float32 frames via ScriptProcessorNode and FRAME (type=2) webm chunks via MediaRecorder (AV1→H264→webm fallback, 100ms timeslice) to `ws://127.0.0.1:9888`.
- `extension/background.js` — Service worker. Gets `tabCapture` stream ID, attaches `chrome.debugger` to the tab, opens a second WebSocket to `ws://127.0.0.1:9231` for CDP bidirectional bridging, and dispatches INPUT (type=5) messages from the main WS as `chrome.debugger` Input events.
- `extension/popup.js` / `extension/popup.html` — UI with two URL inputs (audio/video WS and CDP WS) and status indicators for both connections.
- `extension/manifest.json` — MV3, requires `tabCapture`, `offscreen`, `storage`, `activeTab`, `debugger` permissions.

### Ports

- `ws://127.0.0.1:9888` — audio PCM + webm video frames + INPUT dispatch (main data channel)
- `ws://127.0.0.1:9231` — CDP command/event bridge (extension tab debugger ↔ jerryrig)

### Difference from Electron host

The Electron host captures audio via Web Audio API tap in the preload. The extension uses `chrome.tabCapture` + `getUserMedia` in an offscreen document. CDP in Electron is the built-in `--remote-debugging-port` server. CDP in the extension is `chrome.debugger` attached to the active tab and bridged over WebSocket.

## Hyperswarm Multi-Client Architecture

### SWARM_ROLE=client (legacy Electron viewer)

When `SWARM_ROLE=client`, the Electron app loads `src/electron/remote-view.html` instead of `TARGET_URL`. This page listens for `screen-frame` IPC events (base64-encoded JPEG) and renders them as a live view. The preferred approach for headless remote control is the headless CDP client below.

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

## Companion App

`companion/index.js` is a standalone Node.js script (no Electron) that bridges all browser extension limitations. Run with `node companion/index.js` or `npm run companion`.

### What it bridges

- **Audio**: WS server on `WS_AUDIO_PORT` (default 9888) receives framed binary messages from the extension (4+4+N framing: type LE uint32, length LE uint32, payload). AUDIO frames (type=1) are pushed to the Discord voice pipeline. FRAME (type=2) and INPUT (type=5) frames are forwarded to Hyperswarm peers. Inbound Discord audio is sent back to the extension as AUDIO frames.
- **CDP**: HTTP server on `CDP_BRIDGE_HTTP_PORT` (default 9232) responds to `/json/version` and `/json/list` so agent-browser can connect as if it were a real Chrome CDP server. WS upgrade on `/devtools/browser/companion` accepts agent-browser; commands from agent-browser are forwarded as plain JSON to the extension on port 9231. A second WS server on `CDP_PROXY_PORT` (default 9231) is where the extension's background.js connects as a plain-JSON bidirectional CDP channel: companion sends CDP commands down to the extension, and CDP events from the extension are broadcast back to all agent-browser clients on port 9232.
- **Hyperswarm**: If `SWARM_TOPIC` is set, joins the swarm as a peer and relays audio/frames/input to all connected swarm peers.
- **Discord**: If `DISCORD_BOT_TOKEN`, `GUILD_ID`, and `CHANNEL_ID` are set, logs in, joins the voice channel, pushes extension audio to Discord, and relays inbound Discord audio back to the extension.

### Env vars

- `WS_AUDIO_PORT` — main data channel WS port (default 9888)
- `CDP_PROXY_PORT` — extension CDP WS bridge port (default 9231)
- `CDP_BRIDGE_HTTP_PORT` — agent-browser CDP HTTP+WS port (default 9232)
- `SWARM_TOPIC` — Hyperswarm topic string (optional)
- `DISCORD_BOT_TOKEN`, `GUILD_ID`, `CHANNEL_ID` — Discord voice bridge (optional)

### Reused modules

- `src/bot/voice.js` — PCM PassThrough → Opus encoder → AudioResource → AudioPlayer
- `src/bot/client.js` — discord.js v14 login, voice join, Opus decode
- `src/p2p/swarm.js` — Hyperswarm multi-peer management, framed binary protocol

## VDO.Ninja Relay

Set `VDO_NINJA_ROOM` (and optionally `VDO_NINJA_STREAM_ID`) in `.env` to enable. On app ready, a hidden BrowserWindow loads the VDO.Ninja push URL with `vdo-bridge.cjs` as its preload.

### vdo-bridge.cjs

Runs in the hidden VDO.Ninja BrowserWindow as a preload (`contextIsolation: false`, `webSecurity: false`). Connects to `ws://127.0.0.1:WS_AUDIO_PORT`, parses 4+4+N framed messages, and overrides `navigator.mediaDevices.getUserMedia` / `getDisplayMedia` so VDO.Ninja receives the relay stream.

- FRAME (type=2): fragmented webm chunks fed into `MediaSource` + `SourceBuffer` → `<video>` element → `video.captureStream()` for video track. Codec detected from `MediaSource.isTypeSupported` (AV1 → H264 → plain webm). `sourceBuffer.mode = 'sequence'` handles fragmented webm.
- AUDIO (type=1): Float32 stereo scheduled via `AudioContext.createBufferSource()` → `createMediaStreamDestination()` for audio track.
- Combined stream = `new MediaStream([videoTrack, audioTrack])` built once video is playable.
- `getUserMedia` / `getDisplayMedia` poll until `combinedStream` is ready (up to 5s), then resolve.

### KVM viewer (docs/viewer.html)

GitHub Pages compatible. Load with `?room=ROOM&stream=STREAMID&ws=ws://...`.

- Embeds VDO.Ninja viewer iframe (`pointer-events: none`).
- Transparent overlay `div` captures all mouse and keyboard events.
- Mouse move/down/up/click/wheel → `Input.dispatchMouseEvent` format JSON → framed TYPE_INPUT=5 → WebSocket.
- Key down/up → `Input.dispatchKeyEvent` format JSON → framed TYPE_INPUT=5 → WebSocket.
- WS auto-reconnects every 2s. Status bar shows connection state and stream info.

### Env vars

- `VDO_NINJA_ROOM` — VDO.Ninja room name (required to enable)
- `VDO_NINJA_STREAM_ID` — push stream ID (auto-generated random 6-char if unset)

## File Map

- `src/main.js` — Electron main entry, wires all modules
- `src/p2p/swarm.js` — Hyperswarm multi-peer management, framed binary protocol
- `src/p2p/cdp-proxy.js` — CDP proxy: per-peer host connections, multi-client WS server
- `src/p2p/client.js` — Headless CDP client (no Electron), run with `npm run headless`
- `src/p2p/host.js` — Screen capture for P2P relay
- `src/bot/client.js` — discord.js v14 login, @discordjs/voice join, Opus decode, audio IPC send
- `src/bot/voice.js` — PCM PassThrough → Opus encoder → AudioResource → AudioPlayer
- `src/electron/preload.cjs` — Chrome compat spoof, navbar, audio capture (AudioWorklet intercept) + inbound playback
- `src/electron/vdo-bridge.cjs` — VDO.Ninja hidden window preload: MediaSource webm + AudioContext → getUserMedia override
- `src/electron/error.html` — Fallback page if TARGET_URL fails
- `docs/viewer.html` — KVM viewer: VDO.Ninja iframe + input overlay + WS INPUT dispatch
- `.env.example` — All configurable variables
