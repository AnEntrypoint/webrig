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
