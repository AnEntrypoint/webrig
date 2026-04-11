## 2026-04-12

### Fixed
- **DAVE decrypt failures**: updated `@discordjs/voice` to 0.19.2 and `@snazzah/davey` to 0.1.11 (latest patch releases with DAVE fixes)
- **Voice 4006 stale session**: added bot-user-id filter to VoiceStateUpdate leave confirmation; added explicit voice leave + 2s delay before retry on 4006; added warning message indicating conflicting bot instance as likely cause
- **DAVE debug visibility**: added `transitioned` event listener on networking to log when DAVE key exchange completes

## 2026-04-11

### Added
- **Chrome extension virtual mic**: inbound Discord audio from WS (TYPE_AUDIO) is injected into the active tab as a virtual `getUserMedia` microphone input via CDP `Runtime.evaluate`. `vmic.js` exports `injectVmic`/`pushVmicFrame`. On capture start, background.js injects `window.__vmic_push` + `getUserMedia`/`enumerateDevices` overrides into the tab via debugger. Offscreen forwards inbound AUDIO frames to background via `AUDIO_FRAME` message. Tab apps calling `getUserMedia({audio:true})` receive the virtual "Discord Virtual Mic" stream with live Discord speaker audio.
- **addon-chrome/vmic.js**: new module containing `VMIC_INJECT` script, `injectVmic`, and `pushVmicFrame` (base64-encoded Float32 frames via CDP)
- **manifest.json**: added `"type": "module"` to background service worker to enable ES module imports

## 2026-04-09 (4)

### Fixed
- **webm init segment caching**: main.js detects EBML header in first video frame, caches it, sends to late-joining WS clients and swarm peers — fixes blank video on late connections
- **remote-view.html**: converted from JPEG \<img\> to MediaSource \<video\> with SourceBuffer for webm stream — SWARM_ROLE=client viewer now works with the new webm video path
- **Swarm onFrame**: sends raw Buffer to renderer instead of base64 string

## 2026-04-09 (3)

### Changed
- **Video capture**: replaced JPEG screenshot polling in host.js with MediaRecorder webm capture in preload.cjs via getDisplayMedia + setDisplayMediaRequestHandler
- **host.js**: stripped to thin relay (broadcastFrame → sendFrame to swarm); no more desktopCapturer polling
- **main.js**: added desktopCapturer import, setDisplayMediaRequestHandler, video-frame IPC handler, WS broadcast of TYPE_FRAME=2 webm chunks
- **preload.cjs**: new startVideoCapture — getDisplayMedia → MediaRecorder (AV1/H264, 100ms, 2Mbps) → IPC video-frame
- vdo-bridge.cjs now receives proper webm chunks from Electron host (was previously only working with extension path)

## 2026-04-09 (2)

### Fixed
- **Companion INPUT parse**: wrapped JSON.parse in processFrame MSG.INPUT with try/catch — malformed frames no longer crash the WS framing parser
- **Electron inbound audio**: removed dead preload.cjs audio-inbound listener (was muted by setAudioMuted). Inbound Discord audio reaches WS clients (vdo-bridge, extensions) via _broadcastInbound
- **Port collision**: companion now reads `CDP_EXT_PORT` (falls back to `CDP_PROXY_PORT`), avoiding collision with cdp-proxy.js which uses the same env var

### Removed
- Root `viewer.html` and `index.html` (duplicates of `docs/` — GitHub Pages serves from docs/)

### Documented
- host.js JPEG legacy path (not compatible with vdo-bridge webm)
- Headless CDP client only proxies CDP, not audio/frame
- CDP_EXT_PORT env var for companion extension WS bridge
- setAudioMuted prevents inbound audio from playing in Electron renderer

## 2026-04-09

### Added
- **Electron inbound audio**: main.js now subscribes to Discord speakers via voiceReceiver — decoded PCM sent to renderer via IPC and broadcast to WS clients
- **Preload playback**: preload.cjs listens for 'audio-inbound' IPC and plays Discord speaker audio via AudioContext.createBufferSource (bypasses setAudioMuted)
- **WS inbound relay**: startWsServer tracks connected clients and broadcasts inbound Discord AUDIO frames — enables VDO.Ninja relay of Discord speakers in Electron mode

### Fixed
- **Chrome CDP response**: background.js cdpWs.onmessage now sends {id, result} responses back to companion — agent-browser no longer hangs on CDP commands
- **Chrome extension**: offscreen.js handles inbound TYPE_AUDIO frames from companion — Discord speaker audio plays through AudioContext
- **Firefox extension**: audio-pipeline.js handles inbound TYPE_AUDIO frames — same playback pattern
- Both extensions reset nextPlayTime on stop to prevent scheduling drift

### Documented
- CLAUDE.md: Electron inbound audio flow documented (IPC + WS relay)
- CLAUDE.md: virtual microphone limitation — system-level virtual cable (VB-Cable/BlackHole) required
