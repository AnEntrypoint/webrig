const WS_URL = 'ws://127.0.0.1:' + (typeof process !== 'undefined' && process.env.WS_AUDIO_PORT || '9888')
const TYPE_AUDIO = 1
const TYPE_FRAME = 2
const MAX_PAYLOAD = 10 * 1024 * 1024
const MAX_SB_QUEUE = 60
const MAX_RECV_BUF = 20 * 1024 * 1024
const CODEC_CHAIN = ['video/webm; codecs=av1', 'video/webm; codecs=h264', 'video/webm']
const log = (tag, ...a) => console.log(`[vdo-bridge][${tag}]`, ...a)
const warn = (tag, ...a) => console.warn(`[vdo-bridge][${tag}]`, ...a)

const audioCtx = new AudioContext({ sampleRate: 48000 })
const audioDest = audioCtx.createMediaStreamDestination()
let nextPlayTime = 0

let videoEl = null
let mediaSource = null
let sourceBuffer = null
let sbQueue = []
let combinedStream = null
let wsRetries = 0
let wsBackoff = 1000

function resumeAudioCtx() {
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
}

function scheduleAudio(f32) {
  if (f32.length === 0) return
  if (f32.length % 2 !== 0) { warn('audio', 'odd sample count', f32.length); return }
  resumeAudioCtx()
  const frames = f32.length / 2
  const buf = audioCtx.createBuffer(2, frames, 48000)
  const L = buf.getChannelData(0)
  const R = buf.getChannelData(1)
  for (let i = 0; i < frames; i++) {
    L[i] = Math.max(-1, Math.min(1, f32[i * 2]))
    R[i] = Math.max(-1, Math.min(1, f32[i * 2 + 1]))
  }
  const src = audioCtx.createBufferSource()
  src.buffer = buf
  src.connect(audioDest)
  const now = audioCtx.currentTime
  if (nextPlayTime < now) nextPlayTime = now
  src.start(nextPlayTime)
  nextPlayTime += frames / 48000
}

function flushSb() {
  if (!sourceBuffer || sourceBuffer.updating || sbQueue.length === 0) return
  try { sourceBuffer.appendBuffer(sbQueue.shift()) }
  catch (e) { warn('sb', 'appendBuffer failed:', e.message) }
}

function buildCombinedStream() {
  try {
    const vTracks = videoEl.captureStream().getVideoTracks()
    const aTracks = audioDest.stream.getAudioTracks()
    if (vTracks.length && aTracks.length) {
      combinedStream = new MediaStream([vTracks[0], aTracks[0]])
      log('stream', 'combined stream ready')
    }
  } catch (e) { warn('stream', 'captureStream failed:', e.message) }
}

function detectCodec() {
  for (const c of CODEC_CHAIN) {
    if (MediaSource.isTypeSupported(c)) { log('codec', 'using', c); return c }
  }
  warn('codec', 'no supported codec found, falling back to video/webm')
  return 'video/webm'
}

function initMediaSource(mimeType) {
  mediaSource = new MediaSource()
  videoEl = document.createElement('video')
  videoEl.autoplay = true
  videoEl.muted = true
  videoEl.playsInline = true
  videoEl.style.display = 'none'
  videoEl.src = URL.createObjectURL(mediaSource)
  document.body.appendChild(videoEl)

  mediaSource.addEventListener('sourceopen', () => {
    const type = MediaSource.isTypeSupported(mimeType) ? mimeType : 'video/webm'
    try { sourceBuffer = mediaSource.addSourceBuffer(type) }
    catch (e) { warn('ms', 'addSourceBuffer failed:', e.message); return }
    log('ms', 'sourceBuffer created for', type)
    sourceBuffer.mode = 'sequence'
    sourceBuffer.addEventListener('updateend', () => {
      flushSb()
      if (!combinedStream && videoEl.readyState >= 2) buildCombinedStream()
    })
    sourceBuffer.addEventListener('error', (e) => warn('sb', 'error event', e))
    flushSb()
  })

  mediaSource.addEventListener('sourceended', () => warn('ms', 'sourceended'))
  mediaSource.addEventListener('sourceclose', () => warn('ms', 'sourceclose'))
  videoEl.addEventListener('canplay', () => { if (!combinedStream) buildCombinedStream() })
  videoEl.addEventListener('error', () => warn('video', 'element error', videoEl.error?.message))
}

let mimeDetected = false
function handleFrame(data) {
  if (!mimeDetected) {
    mimeDetected = true
    initMediaSource(detectCodec())
  }
  if (sbQueue.length >= MAX_SB_QUEUE) {
    sbQueue.splice(0, sbQueue.length - MAX_SB_QUEUE / 2)
    warn('sb', 'queue overflow, trimmed to', sbQueue.length)
  }
  sbQueue.push(data)
  flushSb()
}

let recvBuf = new Uint8Array(0)
function onWsData(ab) {
  const incoming = new Uint8Array(ab)
  const merged = new Uint8Array(recvBuf.length + incoming.length)
  merged.set(recvBuf); merged.set(incoming, recvBuf.length)
  recvBuf = merged
  if (recvBuf.length > MAX_RECV_BUF) {
    warn('ws', 'recvBuf exceeded limit, resetting')
    recvBuf = new Uint8Array(0)
    return
  }
  while (recvBuf.length >= 8) {
    const view = new DataView(recvBuf.buffer, recvBuf.byteOffset)
    const type = view.getUint32(0, true)
    const len = view.getUint32(4, true)
    if (len > MAX_PAYLOAD) {
      warn('ws', 'frame too large:', len, 'bytes, resetting buffer')
      recvBuf = new Uint8Array(0)
      return
    }
    if (recvBuf.length < 8 + len) break
    const payload = recvBuf.slice(8, 8 + len)
    recvBuf = recvBuf.slice(8 + len)
    if (type === TYPE_AUDIO) {
      if (payload.byteLength % 4 !== 0) { warn('ws', 'audio payload not aligned to float32'); continue }
      scheduleAudio(new Float32Array(payload.buffer, payload.byteOffset, payload.byteLength / 4))
    } else if (type === TYPE_FRAME) {
      handleFrame(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength))
    } else {
      warn('ws', 'unknown frame type:', type)
    }
  }
}

let ws = null
function connectWs() {
  try { ws = new WebSocket(WS_URL) }
  catch (e) { warn('ws', 'constructor failed:', e.message); scheduleReconnect(); return }
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => { log('ws', 'connected to', WS_URL); wsRetries = 0; wsBackoff = 1000 }
  ws.onmessage = (e) => onWsData(e.data)
  ws.onclose = (e) => { log('ws', 'closed code=' + e.code, 'reason=' + (e.reason || 'none')); scheduleReconnect() }
  ws.onerror = () => warn('ws', 'error')
}

function scheduleReconnect() {
  wsRetries++
  const delay = Math.min(wsBackoff * Math.pow(1.5, wsRetries - 1), 30000)
  log('ws', `reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${wsRetries})`)
  setTimeout(connectWs, delay)
}

connectWs()

const getStream = () => combinedStream ? Promise.resolve(combinedStream)
  : new Promise((resolve, reject) => {
    const t = setInterval(() => { if (combinedStream) { clearInterval(t); resolve(combinedStream) } }, 100)
    setTimeout(() => {
      clearInterval(t)
      if (combinedStream) { resolve(combinedStream); return }
      warn('stream', 'timeout waiting for combined stream, resolving with empty MediaStream')
      resolve(new MediaStream())
    }, 5000)
  })

navigator.mediaDevices.getUserMedia = (constraints) => { log('gum', 'getUserMedia called', JSON.stringify(constraints)); return getStream() }
navigator.mediaDevices.getDisplayMedia = (constraints) => { log('gdm', 'getDisplayMedia called', JSON.stringify(constraints)); return getStream() }
