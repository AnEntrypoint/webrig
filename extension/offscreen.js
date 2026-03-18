let audioCtx = null
let processor = null
let videoTrack = null
let frameInterval = null
let ws = null
let wsUrl = null
let reconnectTimer = null
let active = false
let framePending = false

const TYPE_AUDIO = 1
const TYPE_FRAME = 2

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

function stopFrameLoop() {
  if (frameInterval) { clearInterval(frameInterval); frameInterval = null }
  framePending = false
}

function startFrameLoop(track) {
  const canvas = new OffscreenCanvas(1280, 720)
  const ctx2d = canvas.getContext('2d')
  const imgCapture = new ImageCapture(track)

  track.onended = stopFrameLoop

  frameInterval = setInterval(async () => {
    if (!active || framePending) return
    framePending = true
    try {
      const bitmap = await imgCapture.grabFrame()
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      ctx2d.drawImage(bitmap, 0, 0)
      bitmap.close()
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
      const arrayBuf = await blob.arrayBuffer()
      sendFramed(TYPE_FRAME, arrayBuf)
    } catch (_) {}
    framePending = false
  }, 100)
}

function stopAll() {
  active = false
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  stopFrameLoop()
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
    startFrameLoop(vTrack)
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
