const EXT_ID = document.currentScript?.dataset?.extId || ''

export class InPageCdpClient {
  constructor(extId) {
    this._extId = extId || EXT_ID
    this._listeners = new Map()
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg.method && this._listeners.has(msg.method)) {
          for (const fn of this._listeners.get(msg.method)) fn(msg.params)
        }
      })
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return reject(new Error('extension not available'))
      const target = this._extId ? chrome.runtime.sendMessage.bind(null, this._extId) : chrome.runtime.sendMessage.bind(chrome.runtime)
      target({ type: 'CDP_RPC', method, params }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
        resp?.ok ? resolve(resp.result) : reject(new Error(resp?.error || 'cdp error'))
      })
    })
  }

  on(method, fn) {
    if (!this._listeners.has(method)) this._listeners.set(method, [])
    this._listeners.get(method).push(fn)
    return () => { const arr = this._listeners.get(method); const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1) }
  }

  navigate(url) { return this.send('Page.navigate', { url }) }
  eval(expr) { return this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }) }
  async snapshot() {
    const doc = await this.send('DOM.getDocument', { depth: -1, pierce: true })
    const { outerHTML } = await this.send('DOM.getOuterHTML', { nodeId: doc.root.nodeId })
    return outerHTML
  }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    return this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }
}

export function createInPageCdpClient(extId) { return new InPageCdpClient(extId) }
