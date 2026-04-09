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
