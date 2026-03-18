const WS_URL = 'ws://127.0.0.1:' + (typeof process !== 'undefined' && process.env.WS_AUDIO_PORT || '9888')
const TYPE_AUDIO = 1
const TYPE_FRAME = 2

const audioCtx = new AudioContext({ sampleRate: 48000 })
const audioDest = audioCtx.createMediaStreamDestination()
let nextPlayTime = 0

let videoEl = null
let mediaSource = null
let sourceBuffer = null
let sbQueue = []
let combinedStream = null

function scheduleAudio(f32) {
  const frames = f32.length / 2
  const buf = audioCtx.createBuffer(2, frames, 48000)
  const L = buf.getChannelData(0)
  const R = buf.getChannelData(1)
  for (let i = 0; i < frames; i++) { L[i] = f32[i * 2]; R[i] = f32[i * 2 + 1] }
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
  try { sourceBuffer.appendBuffer(sbQueue.shift()) } catch {}
}

function buildCombinedStream() {
  const vTracks = videoEl.captureStream().getVideoTracks()
  const aTracks = audioDest.stream.getAudioTracks()
  if (vTracks.length && aTracks.length) {
    combinedStream = new MediaStream([vTracks[0], aTracks[0]])
  }
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
    try { sourceBuffer = mediaSource.addSourceBuffer(type) } catch { return }
    sourceBuffer.mode = 'sequence'
    sourceBuffer.addEventListener('updateend', () => {
      flushSb()
      if (!combinedStream && videoEl.readyState >= 2) buildCombinedStream()
    })
    sourceBuffer.addEventListener('error', () => {})
    flushSb()
  })

  videoEl.addEventListener('canplay', () => { if (!combinedStream) buildCombinedStream() })
}

let mimeDetected = false
function handleFrame(data) {
  if (!mimeDetected) {
    mimeDetected = true
    let mime = 'video/webm'
    if (MediaSource.isTypeSupported('video/webm; codecs=av1')) mime = 'video/webm; codecs=av1'
    else if (MediaSource.isTypeSupported('video/webm; codecs=h264')) mime = 'video/webm; codecs=h264'
    initMediaSource(mime)
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
  while (recvBuf.length >= 8) {
    const view = new DataView(recvBuf.buffer, recvBuf.byteOffset)
    const type = view.getUint32(0, true)
    const len = view.getUint32(4, true)
    if (recvBuf.length < 8 + len) break
    const payload = recvBuf.slice(8, 8 + len)
    recvBuf = recvBuf.slice(8 + len)
    if (type === TYPE_AUDIO) scheduleAudio(new Float32Array(payload.buffer, payload.byteOffset, payload.byteLength / 4))
    else if (type === TYPE_FRAME) handleFrame(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength))
  }
}

let ws = null
function connectWs() {
  ws = new WebSocket(WS_URL)
  ws.binaryType = 'arraybuffer'
  ws.onmessage = (e) => onWsData(e.data)
  ws.onclose = () => setTimeout(connectWs, 2000)
  ws.onerror = () => {}
}
connectWs()

const getStream = () => combinedStream ? Promise.resolve(combinedStream)
  : new Promise((resolve) => {
    const t = setInterval(() => { if (combinedStream) { clearInterval(t); resolve(combinedStream) } }, 100)
    setTimeout(() => { clearInterval(t); resolve(combinedStream || new MediaStream()) }, 5000)
  })

navigator.mediaDevices.getUserMedia = () => getStream()
navigator.mediaDevices.getDisplayMedia = () => getStream()
