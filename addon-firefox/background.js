const hasDebugger = () => typeof api !== 'undefined' && !!api.debugger

function connectCdpWs() {
  if (cdpReconnectTimer) { clearTimeout(cdpReconnectTimer); cdpReconnectTimer = null }
  cdpWs = new WebSocket(cdpWsUrl)
  cdpWs.onopen = () => {}
  cdpWs.onmessage = (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }
    if (!activeTabId || !hasDebugger()) return
    if (msg.id !== undefined) {
      api.debugger.sendCommand({ tabId: activeTabId }, msg.method, msg.params || {}).then((result) => {
        if (cdpWs && cdpWs.readyState === WebSocket.OPEN) cdpWs.send(JSON.stringify({ id: msg.id, result: result || {} }))
      }).catch((err) => {
        console.warn('[bg] CDP send error:', err)
        if (cdpWs && cdpWs.readyState === WebSocket.OPEN) cdpWs.send(JSON.stringify({ id: msg.id, error: { message: err.message || String(err) } }))
      })
    } else {
      api.debugger.sendCommand({ tabId: activeTabId }, msg.method, msg.params || {}).catch((err) => {
        console.warn('[bg] CDP send error:', err)
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

if (hasDebugger()) {
  api.debugger.onEvent.addListener((_src, method, params) => {
    if (cdpWs && cdpWs.readyState === WebSocket.OPEN) {
      cdpWs.send(JSON.stringify({ method, params }))
    }
  })

  api.debugger.onDetach.addListener(() => {
    cdpAttached = false
  })
}

function attachDebugger(tabId) {
  if (!hasDebugger()) return Promise.resolve()
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
  if (!hasDebugger()) return
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

  if (!api.tabCapture) return Promise.reject(new Error('tabCapture API not available — requires Firefox 109+'))

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
  const detach = hasDebugger() && cdpAttached && activeTabId
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
  if (msg.type === 'CDP_RPC' && activeTabId) {
    if (!hasDebugger()) { sendResponse({ ok: false, error: 'debugger API not available' }); return false }
    api.debugger.sendCommand({ tabId: activeTabId }, msg.method, msg.params || {}).then(result => {
      sendResponse({ ok: true, result: result || {} })
    }).catch(err => {
      sendResponse({ ok: false, error: err.message || String(err) })
    })
    return true
  }
  if (msg.type === 'STATUS') {
    sendResponse({ capturing, cdpAttached })
    return false
  }
})
