const api = typeof browser !== 'undefined' ? browser : chrome

let capturing = false
let cdpAttached = false
let activeTabId = null
let cdpWs = null
let cdpWsUrl = null
let cdpReconnectTimer = null
let cdpActive = false

let audioCtx = null
let processor = null
let mediaRecorder = null
let ws = null
let wsUrl = null
let wsReconnectTimer = null
let captureActive = false

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
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null }
  ws = new WebSocket(wsUrl)
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => {}
  ws.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer) || e.data.byteLength < 8) return
    const view = new DataView(e.data)
    const type = view.getUint32(0, true)
    const len = view.getUint32(4, true)
    if (type === TYPE_INPUT && activeTabId) {
      const payload = e.data.slice(8, 8 + len)
      dispatchInput(activeTabId, payload)
    }
  }
  ws.onclose = () => {
    ws = null
    if (captureActive) wsReconnectTimer = setTimeout(connectWs, 2000)
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
    if (!captureActive || !e.data || e.data.size === 0) return
    const arrayBuf = await e.data.arrayBuffer()
    sendFramed(TYPE_FRAME, arrayBuf)
  }
  track.onended = stopMediaRecorder
  mediaRecorder.start(100)
}

function stopCapturePipeline() {
  captureActive = false
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null }
  stopMediaRecorder()
  if (processor) { try { processor.disconnect() } catch {} processor = null }
  if (audioCtx) { try { audioCtx.close() } catch {} audioCtx = null }
  if (ws) { try { ws.close() } catch {} ws = null }
}

function startCapturePipeline(stream, url) {
  wsUrl = url
  captureActive = true
  connectWs()

  const vTrack = stream.getVideoTracks()[0]
  if (vTrack) {
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