let capturing = false
let cdpAttached = false
let activeTabId = null
let cdpWs = null
let cdpWsUrl = null
let cdpReconnectTimer = null
let cdpActive = false

const TYPE_INPUT = 5

function connectCdpWs() {
  if (cdpReconnectTimer) { clearTimeout(cdpReconnectTimer); cdpReconnectTimer = null }
  cdpWs = new WebSocket(cdpWsUrl)
  cdpWs.onopen = () => {}
  cdpWs.onmessage = (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }
    if (!activeTabId) return
    chrome.debugger.sendCommand({ tabId: activeTabId }, msg.method, msg.params || {}, () => {
      if (chrome.runtime.lastError) console.warn('[bg] CDP send error:', chrome.runtime.lastError.message)
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

chrome.debugger.onEvent.addListener((_src, method, params) => {
  if (cdpWs && cdpWs.readyState === WebSocket.OPEN) {
    cdpWs.send(JSON.stringify({ method, params }))
  }
})

chrome.debugger.onDetach.addListener(() => {
  cdpAttached = false
})

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument()
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Capture tab audio/video and stream to WebSocket'
    })
  }
}

async function attachDebugger(tabId) {
  if (cdpAttached && activeTabId === tabId) return
  if (cdpAttached) {
    await new Promise((r) => chrome.debugger.detach({ tabId: activeTabId }, r))
    cdpAttached = false
  }
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else resolve()
    })
  })
  cdpAttached = true
}

async function startCapture(wsUrl, cdpUrl, tabId) {
  await ensureOffscreen()
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else resolve(id)
    })
  })
  activeTabId = tabId
  cdpWsUrl = cdpUrl
  cdpActive = true
  connectCdpWs()
  await attachDebugger(tabId)
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_START', streamId, wsUrl })
  capturing = true
}

async function stopCapture() {
  capturing = false
  stopCdpWs()
  if (cdpAttached && activeTabId) {
    await new Promise((r) => chrome.debugger.detach({ tabId: activeTabId }, r))
    cdpAttached = false
  }
  activeTabId = null
  const existing = await chrome.offscreen.hasDocument()
  if (existing) {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' })
    await chrome.offscreen.closeDocument()
  }
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
  chrome.debugger.sendCommand({ tabId }, method, params, () => {
    if (chrome.runtime.lastError) console.warn('[bg] input dispatch error:', chrome.runtime.lastError.message)
  })
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
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
  if (msg.type === 'INPUT_FRAME' && activeTabId) {
    dispatchInput(activeTabId, msg.payload)
    return false
  }
})
