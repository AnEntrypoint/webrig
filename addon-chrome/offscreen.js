let audioCtx = null
let processor = null
let videoTrack = null
let mediaRecorder = null
let ws = null
let wsUrl = null
let reconnectTimer = null
let active = false
let nextPlayTime = 0

const TYPE_AUDIO = 1
const TYPE_FRAME = 2
const TYPE_INPUT = 5

function framed(type, payload) {
  const buf = new ArrayBuffer(8 + payload.byteLength)
  const view = new DataView(buf)
  view.setUint32(0, type, true)
  view.setUint32(4, payload.byteLength, true)
  new Uint8Array(buf, 8).set(new Uint8Array(payload))
  return buf
}

function sendFramed(type, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(framed(type, payload))
}

function connectWs() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  ws = new WebSocket(wsUrl)
  ws.binaryType = 'arraybuffer'
  ws.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer) || e.data.byteLength < 8) return
    const view = new DataView(e.data)
    const type = view.getUint32(0, true)
    const len = view.getUint32(4, true)
    if (type === TYPE_AUDIO) {
      if (len % 4 !== 0 || !audioCtx) return
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
      const f32 = new Float32Array(e.data, 8, len / 4)
      const frames = f32.length / 2
      const buf = audioCtx.createBuffer(2, frames, 48000)
      const L = buf.getChannelData(0)
      const R = buf.getChannelData(1)
      for (let i = 0; i < frames; i++) { L[i] = Math.max(-1, Math.min(1, f32[i * 2])); R[i] = Math.max(-1, Math.min(1, f32[i * 2 + 1])) }
      const src = audioCtx.createBufferSource()
      src.buffer = buf
      src.connect(audioCtx.destination)
      const now = audioCtx.currentTime
      if (nextPlayTime < now) nextPlayTime = now
      src.start(nextPlayTime)
      nextPlayTime += frames / 48000
    } else if (type === TYPE_INPUT) {
      const payload = new TextDecoder().decode(e.data.slice(8, 8 + len))
      chrome.runtime.sendMessage({ type: 'INPUT_FRAME', payload })
    }
  }
  ws.onclose = () => {
    ws = null
    if (active) reconnectTimer = setTimeout(connectWs, 2000)
  }
  ws.onerror = () => {}
}

function stopMediaRecorder() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop() } catch {}
  }
  mediaRecorder = null
}

function startMediaRecorder(track) {
  const videoStream = new MediaStream([track])
  const codecs = [
    'video/webm; codecs=av1',
    'video/webm; codecs=h264',
    'video/webm',
  ]
  const mimeType = codecs.find((c) => MediaRecorder.isTypeSupported(c)) || ''
  mediaRecorder = new MediaRecorder(videoStream, { mimeType, videoBitsPerSecond: 2_000_000 })
  mediaRecorder.ondataavailable = async (e) => {
    if (!active || !e.data || e.data.size === 0) return
    const arrayBuf = await e.data.arrayBuffer()
    sendFramed(TYPE_FRAME, arrayBuf)
  }
  track.onended = stopMediaRecorder
  mediaRecorder.start(100)
}

function stopAll() {
  active = false
  nextPlayTime = 0
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  stopMediaRecorder()
  if (videoTrack) { try { videoTrack.stop() } catch {} videoTrack = null }
  if (processor) { try { processor.disconnect() } catch {} processor = null }
  if (audioCtx) { try { audioCtx.close() } catch {} audioCtx = null }
  if (ws) { try { ws.close() } catch {} ws = null }
}

async function startCapture(streamId, url) {
  wsUrl = url
  active = true
  connectWs()

  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
    })
  } catch (_) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false
    })
  }

  const vTrack = stream.getVideoTracks()[0]
  if (vTrack) {
    videoTrack = vTrack
    startMediaRecorder(vTrack)
  }

  audioCtx = new AudioContext({ sampleRate: 48000 })
  const source = audioCtx.createMediaStreamSource(stream)
  processor = audioCtx.createScriptProcessor(4096, 2, 2)

  processor.onaudioprocess = (e) => {
    const left = e.inputBuffer.getChannelData(0)
    const right = e.inputBuffer.getChannelData(1)
    const interleaved = new Float32Array(left.length * 2)
    for (let i = 0; i < left.length; i++) {
      interleaved[i * 2] = left[i]
      interleaved[i * 2 + 1] = right[i]
    }
    sendFramed(TYPE_AUDIO, interleaved.buffer)
  }

  source.connect(processor)
  processor.connect(audioCtx.destination)
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'OFFSCREEN_START') {
    startCapture(msg.streamId, msg.wsUrl).catch((e) => console.error('[offscreen]', e))
  }
  if (msg.type === 'OFFSCREEN_STOP') {
    stopAll()
  }
})
