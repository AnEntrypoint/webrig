## 2026-04-09

### Fixed
- **Chrome extension**: offscreen.js now handles inbound TYPE_AUDIO frames from companion — Discord speaker audio plays through the browser tab's AudioContext
- **Firefox extension**: audio-pipeline.js now handles inbound TYPE_AUDIO frames from companion — same inbound playback via the existing capture AudioContext
- Both extensions reset nextPlayTime on stop to prevent scheduling drift on reconnect

### Documented
- CLAUDE.md: inbound audio flow updated to reflect Chrome/Firefox playback implementation
- CLAUDE.md: virtual microphone limitation documented — system-level virtual cable (VB-Cable/BlackHole) required for true mic routing
