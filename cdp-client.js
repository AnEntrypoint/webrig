const WS = typeof WebSocket !== 'undefined' ? WebSocket : (await import('ws')).WebSocket

export class CdpClient {
  constructor(url = 'ws://127.0.0.1:9232/devtools/browser/companion') {
    this._url = url
    this._ws = null
    this._id = 0
    this._pending = new Map()
    this._listeners = new Map()
    this._onDisconnect = null
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WS(this._url)
      ws.onopen = () => { this._ws = ws; resolve(this) }
      ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data) } catch { return }
        if (msg.id != null && this._pending.has(msg.id)) {
          const { resolve, reject } = this._pending.get(msg.id)
          this._pending.delete(msg.id)
          msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error))) : resolve(msg.result ?? msg)
        } else if (msg.method) {
          for (const fn of (this._listeners.get(msg.method) || [])) fn(msg.params)
          for (const fn of (this._listeners.get('*') || [])) fn(msg.method, msg.params)
        }
      }
      ws.onclose = () => { this._ws = null; this._onDisconnect?.() }
      ws.onerror = (e) => reject(new Error(e.message || 'ws error'))
    })
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this._ws || this._ws.readyState !== 1) return reject(new Error('not connected'))
      const id = ++this._id
      this._pending.set(id, { resolve, reject })
      this._ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this._pending.has(id)) { this._pending.delete(id); reject(new Error('cdp timeout: ' + method)) } }, 30000)
    })
  }

  on(method, fn) {
    if (!this._listeners.has(method)) this._listeners.set(method, [])
    this._listeners.get(method).push(fn)
    return () => { const arr = this._listeners.get(method); const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1) }
  }

  onDisconnect(fn) { this._onDisconnect = fn }

  close() { this._ws?.close() }

  navigate(url) { return this.send('Page.navigate', { url }) }
  reload() { return this.send('Page.reload', {}) }
  eval(expr) { return this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }) }
  getDocument() { return this.send('DOM.getDocument', { depth: -1, pierce: true }) }
  querySelector(selector, nodeId) { return this.send('DOM.querySelector', { nodeId: nodeId || 1, selector }) }
  getOuterHTML(nodeId) { return this.send('DOM.getOuterHTML', { nodeId }) }
  screenshot() { return this.send('Page.captureScreenshot', { format: 'png' }) }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    return this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }
  async type(text) {
    for (const char of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: char })
    }
  }
  async snapshot() {
    const doc = await this.getDocument()
    const { outerHTML } = await this.getOuterHTML(doc.root.nodeId)
    return outerHTML
  }
  async waitForLoad(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('load timeout')), timeoutMs)
      const off = this.on('Page.loadEventFired', () => { clearTimeout(t); off(); resolve() })
    })
  }
}

export async function createCdpClient(url) {
  const client = new CdpClient(url)
  await client.connect()
  return client
}
