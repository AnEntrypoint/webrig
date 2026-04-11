import { injectVmic, pushVmicFrame } from './vmic.js'

let capturing = false
let cdpAttached = false
let activeTabId = null
let targetTabId = null
let cdpWs = null
let cdpWsUrl = null
let cdpReconnectTimer = null
let cdpActive = false
const vmicState = { injected: false, queue: [] }
globalThis.__bgState = () => ({ capturing, cdpAttached, activeTabId, vmicInjected: vmicState.injected, vmicQueueLen: vmicState.queue.length })

const TYPE_INPUT = 5

function connectCdpWs() {
  if (cdpReconnectTimer) { clearTimeout(cdpReconnectTimer); cdpReconnectTimer = null }
  cdpWs = new WebSocket(cdpWsUrl)
  cdpWs.onopen = () => {}
  cdpWs.onmessage = (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }
    if (!activeTabId) return
    if (msg.id !== undefined) {
      chrome.debugger.sendCommand({ tabId: activeTabId }, msg.method, msg.params || {}, (result) => {
        if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) return
        if (chrome.runtime.lastError) cdpWs.send(JSON.stringify({ id: msg.id, error: { message: chrome.runtime.lastError.message } }))
        else cdpWs.send(JSON.stringify({ id: msg.id, result: result || {} }))
      })
    } else {
      chrome.debugger.sendCommand({ tabId: activeTabId }, msg.method, msg.params || {}, () => {
        if (chrome.runtime.lastError) console.warn('[bg] CDP send error:', chrome.runtime.lastError.message)
      })
    }
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
  injectVmic(tabId, vmicState)
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_START', streamId, wsUrl })
  capturing = true
}

async function stopCapture() {
  capturing = false
  vmicState.injected = false
  vmicState.queue.length = 0
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

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === targetTabId) { targetTabId = null }
  if (tabId === activeTabId) { cdpAttached = false; activeTabId = null }
})

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

  if (msg.type === 'TABS_LIST') {
    chrome.tabs.query({}, (tabs) => {
      sendResponse(tabs.map(t => ({ id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl })))
    })
    return true
  }
  if (msg.type === 'SET_TARGET_TAB') {
    const tid = msg.tabId
    if (!tid) { sendResponse({ ok: false, error: 'tabId required' }); return false }
    const prev = targetTabId
    targetTabId = tid
    if (cdpAttached && prev && prev !== tid) chrome.debugger.detach({ tabId: prev }, () => { cdpAttached = false })
    attachDebugger(tid).then(() => sendResponse({ ok: true, tabId: tid })).catch(e => sendResponse({ ok: false, error: e.message }))
    return true
  }
  if (msg.type === 'CDP_CONTROL') {
    if (!targetTabId) { sendResponse({ ok: false, error: 'no target tab set' }); return false }
    chrome.debugger.sendCommand({ tabId: targetTabId }, msg.method, msg.params || {}, (result) => {
      sendResponse(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : { ok: true, result: result || {} })
    })
    return true
  }
  if (msg.type === 'GET_TARGET') {
    sendResponse({ targetTabId })
    return false
  }
  if (msg.type === 'CDP_RPC' && activeTabId) {
    chrome.debugger.sendCommand({ tabId: activeTabId }, msg.method, msg.params || {}, (result) => {
      sendResponse(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : { ok: true, result: result || {} })
    })
    return true
  }
  if (msg.type === 'INPUT_FRAME' && activeTabId) {
    dispatchInput(activeTabId, typeof msg.payload === 'string' ? new TextEncoder().encode(msg.payload) : msg.payload)
    return false
  }
  if (msg.type === 'AUDIO_FRAME' && msg.data && activeTabId) {
    const f32 = new Float32Array(msg.data)
    if (!vmicState.injected) { vmicState.queue.push(f32); return false }
    pushVmicFrame(activeTabId, f32)
    return false
  }
})
