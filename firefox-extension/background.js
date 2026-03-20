const browser = globalThis.browser || globalThis.chrome
const TYPE_AUDIO = 1
const TYPE_FRAME = 2

let capturing = false
let activeTabId = null
let ws = null
let wsUrl = null
let reconnectTimer = null
let active = false
let audioCtx = null
let processor = null
let mediaRecorder = null
let captureStream = null

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
  const codecs = ['video/webm; codecs=av1', 'video/webm; codecs=h264', 'video/webm']
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
  capturing = false
  activeTabId = null
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  stopMediaRecorder()
  if (captureStream) {
    captureStream.getTracks().forEach((t) => { try { t.stop() } catch {} })
    captureStream = null
  }
  if (processor) { try { processor.disconnect() } catch {} processor = null }
  if (audioCtx) { try { audioCtx.close() } catch {} audioCtx = null }
  if (ws) { try { ws.close() } catch {} ws = null }
}

async function startCapture(url, tabId) {
  wsUrl = url
  activeTabId = tabId
  active = true
  connectWs()

  let stream
  try {
    stream = await browser.tabCapture.capture({ audio: true, video: true })
  } catch (_) {
    stream = await browser.tabCapture.capture({ audio: true, video: false })
  }
  if (!stream) throw new Error('tabCapture.capture returned null')
  captureStream = stream

  const vTrack = stream.getVideoTracks()[0]
  if (vTrack) startMediaRecorder(vTrack)

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
  capturing = true
}

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START') {
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const tabId = tabs[0]?.id
      if (!tabId) { sendResponse({ ok: false, error: 'no active tab' }); return }
      startCapture(msg.wsUrl, tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }))
    })
    return true
  }
  if (msg.type === 'STOP') {
    stopAll()
    sendResponse({ ok: true })
    return false
  }
  if (msg.type === 'STATUS') {
    sendResponse({ capturing })
    return false
  }
})
