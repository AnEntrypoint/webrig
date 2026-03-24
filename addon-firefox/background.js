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

function connectCdpWs() {
  if (cdpReconnectTimer) { clearTimeout(cdpReconnectTimer); cdpReconnectTimer = null }
  cdpWs = new WebSocket(cdpWsUrl)
  cdpWs.onopen = () => {}
  cdpWs.onmessage = (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }
    if (!activeTabId) return
    api.debugger.sendCommand({ tabId: activeTabId }, msg.method, msg.params || {}).catch((err) => {
      console.warn('[bg] CDP send error:', err)
    })
  }
  cdpWs.onclose = () => {
    cdpWs = null
    if (cdpActive) cdpReconnectTimer = setTimeout(connectCdpWs, 2000)
  }
  cdpWs.onerror = () => {}
}

function stopCdpWs() {
  cdpActive = false
  if (cdpReconnectTimer) { clearTimeout(cdpReconnectTimer); cdpReconnectTimer = null }
  if (cdpWs) { try { cdpWs.close() } catch {} cdpWs = null }
}

api.debugger.onEvent.addListener((_src, method, params) => {
  if (cdpWs && cdpWs.readyState === WebSocket.OPEN) {
    cdpWs.send(JSON.stringify({ method, params }))
  }
})

api.debugger.onDetach.addListener(() => {
  cdpAttached = false
})

function attachDebugger(tabId) {
  if (cdpAttached && activeTabId === tabId) return Promise.resolve()
  const detachFirst = cdpAttached
    ? api.debugger.detach({ tabId: activeTabId }).catch(() => {})
    : Promise.resolve()
  return detachFirst.then(() => {
    cdpAttached = false
    return api.debugger.attach({ tabId }, '1.3')
  }).then(() => {
    cdpAttached = true
  })
}

function dispatchInput(tabId, payload) {
  let evt
  try { evt = JSON.parse(new TextDecoder().decode(payload)) } catch { return }
  const dispatchType = evt.dispatchType || evt.type
  const method = dispatchType === 'mouseEvent' ? 'Input.dispatchMouseEvent'
    : dispatchType === 'keyEvent' ? 'Input.dispatchKeyEvent'
    : null
  if (!method) return
  const params = Object.assign({}, evt)
  delete params.dispatchType
  api.debugger.sendCommand({ tabId }, method, params).catch((err) => {
    console.warn('[bg] input dispatch error:', err)
  })
}

function startCapture(url, cdpUrl, tabId) {
  activeTabId = tabId
  cdpWsUrl = cdpUrl
  cdpActive = true
  connectCdpWs()

  return new Promise((resolve, reject) => {
    api.tabCapture.capture({ audio: true, video: true }, (stream) => {
      if (api.runtime.lastError) {
        api.tabCapture.capture({ audio: true, video: false }, (audioStream) => {
          if (api.runtime.lastError) {
            reject(new Error(api.runtime.lastError.message))
          } else {
            startCapturePipeline(audioStream, url)
            resolve()
          }
        })
      } else {
        startCapturePipeline(stream, url)
        resolve()
      }
    })
  }).then(() => attachDebugger(tabId)).then(() => { capturing = true })
}

function stopCapture() {
  capturing = false
  stopCapturePipeline()
  stopCdpWs()
  const detach = cdpAttached && activeTabId
    ? api.debugger.detach({ tabId: activeTabId }).catch(() => {}).then(() => { cdpAttached = false })
    : Promise.resolve()
  return detach.then(() => { activeTabId = null })
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START') {
    api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id
      if (!tabId) { sendResponse({ ok: false, error: 'no active tab' }); return }
      const cdpUrl = msg.cdpWsUrl || 'ws://127.0.0.1:9231'
      startCapture(msg.wsUrl, cdpUrl, tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }))
    })
    return true
  }
  if (msg.type === 'STOP') {
    stopCapture().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }))
    return true
  }
  if (msg.type === 'STATUS') {
    sendResponse({ capturing, cdpAttached })
    return false
  }
})
