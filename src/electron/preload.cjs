console.log('[preload] script start')
const { ipcRenderer } = require('electron')
ipcRenderer.send('log', '[preload] loaded on ' + location.href.slice(0, 60))

const SAMPLE_RATE = 48000

let captureCtx = null
let captureGen = 0
let workletNode = null

void (function spoofBrowserEnv() {
  try {
    const CHROME_VER = '134'
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    const brands = [
      { brand: 'Chromium', version: CHROME_VER },
      { brand: 'Google Chrome', version: CHROME_VER },
      { brand: 'Not:A-Brand', version: '99' },
    ]

    const def = (obj, prop, get) => { try { Object.defineProperty(obj, prop, { get, configurable: true }) } catch (_) {} }

    const _nativeToString = Function.prototype.toString
    const _nativeFns = new WeakSet()
    const markNative = (fn) => { _nativeFns.add(fn); return fn }
    Function.prototype.toString = function () {
      if (_nativeFns.has(this)) return 'function ' + (this.name || '') + '() { [native code] }'
      return _nativeToString.call(this)
    }
    _nativeFns.add(Function.prototype.toString)

    try {
      const _wdDesc = Object.getOwnPropertyDescriptor(navigator, 'webdriver')
      if (!_wdDesc || _wdDesc.configurable) {
        Object.defineProperty(navigator, 'webdriver', { value: false, enumerable: false, configurable: false, writable: false })
      }
    } catch (_) {}
    def(navigator, 'userAgent', () => UA)
    def(navigator, 'appVersion', () => '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36')
    def(navigator, 'platform', () => 'Win32')
    def(navigator, 'vendor', () => 'Google Inc.')
    def(navigator, 'language', () => 'en-US')
    def(navigator, 'languages', () => ['en-US', 'en'])
    def(navigator, 'hardwareConcurrency', () => 8)
    def(navigator, 'deviceMemory', () => 8)
    def(navigator, 'doNotTrack', () => null)
    def(navigator, 'maxTouchPoints', () => 0)
    def(navigator, 'cookieEnabled', () => true)
    def(navigator, 'onLine', () => true)
    def(navigator, 'pdfViewerEnabled', () => true)
    def(navigator, 'getAutoplayPolicy', () => markNative(function getAutoplayPolicy() { return 'allowed' }))

    def(navigator, 'plugins', () => {
      const arr = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ]
      try { arr.__proto__ = PluginArray.prototype } catch (_) {}
      return arr
    })

    def(navigator, 'mimeTypes', () => {
      const pdfPlugin = { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
      const arr = [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: pdfPlugin },
        { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: pdfPlugin },
      ]
      try { arr.__proto__ = MimeTypeArray.prototype } catch (_) {}
      return arr
    })

    const _hev = { architecture: 'x86', bitness: '64', brands, fullVersionList: brands.map(b => ({ brand: b.brand, version: b.version + '.0.0.0' })), mobile: false, model: '', platform: 'Windows', platformVersion: '15.0.0', uaFullVersion: '134.0.0.0' }
    class NavigatorUAData {
      get brands() { return brands }
      get mobile() { return false }
      get platform() { return 'Windows' }
      toJSON() { return { brands, mobile: false, platform: 'Windows' } }
      getHighEntropyValues() { return Promise.resolve(_hev) }
    }
    Object.defineProperty(NavigatorUAData.prototype, Symbol.toStringTag, { get: () => 'NavigatorUAData', configurable: true })
    NavigatorUAData.prototype.getHighEntropyValues = markNative(NavigatorUAData.prototype.getHighEntropyValues)
    const uaDataObj = new NavigatorUAData()
    def(navigator, 'userAgentData', () => uaDataObj)

    class NetworkInformation {
      get downlink() { return 10 }
      get downlinkMax() { return Infinity }
      get effectiveType() { return '4g' }
      get rtt() { return 50 }
      get saveData() { return false }
      get type() { return 'unknown' }
      get onchange() { return null }
      addEventListener() {}
      removeEventListener() {}
    }
    Object.defineProperty(NetworkInformation.prototype, Symbol.toStringTag, { get: () => 'NetworkInformation', configurable: true })
    def(navigator, 'connection', () => new NetworkInformation())
    try { def(screen, 'colorDepth', () => 24); def(screen, 'pixelDepth', () => 24) } catch (_) {}
    try { if (screen.orientation) { def(screen.orientation, 'type', () => 'landscape-primary'); def(screen.orientation, 'angle', () => 0) } } catch (_) {}
    try {
      const _origMemDesc = Object.getOwnPropertyDescriptor(performance, 'memory')
      const _origMemGet = _origMemDesc && _origMemDesc.get
      Object.defineProperty(performance, 'memory', {
        get: () => {
          const m = _origMemGet ? _origMemGet.call(performance) : null
          return {
            jsHeapSizeLimit: m ? m.jsHeapSizeLimit : 4294705152,
            totalJSHeapSize: m ? m.totalJSHeapSize : 22020096,
            usedJSHeapSize: m ? m.usedJSHeapSize : 16775168,
          }
        },
        configurable: true, enumerable: true
      })
    } catch (_) {}

    const patchWebGL = (ctor) => {
      try {
        const _get = ctor.prototype.getParameter
        const patched = markNative(function getParameter(p) {
          if (p === 37445) return 'Google Inc. (NVIDIA)'
          if (p === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
          return _get.call(this, p)
        })
        ctor.prototype.getParameter = patched
      } catch (_) {}
    }
    patchWebGL(WebGLRenderingContext)
    if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext)

    const _evtStub = () => ({ addListener: () => {}, removeListener: () => {}, hasListener: () => false })
    const _portStub = () => ({ onMessage: _evtStub(), onDisconnect: _evtStub(), postMessage: () => {}, disconnect: () => {} })
    if (!window.chrome) window.chrome = {}
    window.chrome.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: markNative(function getDetails() { return null }),
      getIsInstalled: markNative(function getIsInstalled() { return false }),
      runningState: markNative(function runningState() { return 'cannot_run' }),
    }
    window.chrome.runtime = {
      id: undefined,
      lastError: undefined,
      PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
      PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
      OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
      onMessage: _evtStub(), onConnect: _evtStub(), onInstalled: _evtStub(),
      connect: markNative(function connect() { return _portStub() }),
      sendMessage: markNative(function sendMessage() {}),
      getManifest: markNative(function getManifest() { return undefined }),
      getURL: markNative(function getURL() { return '' }),
      getContexts: markNative(function getContexts() { return Promise.resolve([]) }),
    }
    window.chrome.webstore = { onInstallStageChanged: _evtStub(), onDownloadProgress: _evtStub(), install: markNative(function install() { return Promise.resolve() }) }
    try {
      delete window.chrome.cast
      const _chromeTarget = window.chrome
      const _castBlocked = new Set(['cast'])
      window.chrome = new Proxy(_chromeTarget, {
        set(t, k, v) { if (_castBlocked.has(k)) return true; t[k] = v; return true },
        defineProperty(t, k, d) { if (_castBlocked.has(k)) return true; return Object.defineProperty(t, k, d), true },
      })
    } catch (_) {}
    if (!window.chrome.loadTimes) window.chrome.loadTimes = markNative(function loadTimes() { const t = Date.now() / 1000; return { commitLoadTime: t, connectionInfo: 'h2', finishDocumentLoadTime: 0, finishLoadTime: 0, firstPaintAfterLoadTime: 0, firstPaintTime: 0, navigationType: 'Other', npnNegotiatedProtocol: 'h2', requestTime: t, startLoadTime: t, wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true } })
    if (!window.chrome.csi) window.chrome.csi = markNative(function csi() { return { onloadT: Date.now(), pageT: 1000, startE: Date.now(), tran: 15 } })

    try {
      if (typeof window.external === 'undefined') window.external = {}
    } catch (_) {}

    try {
      const _query = navigator.permissions.query.bind(navigator.permissions)
      const patchedQuery = markNative(function query(desc) {
        if (desc && desc.name === 'notifications') return Promise.resolve({ state: 'prompt', onchange: null })
        return _query(desc)
      })
      navigator.permissions.query = patchedQuery
    } catch (_) {}

    delete window.electron
    delete window.__electronjs
    try { delete window.require } catch (_) {}
    try { if (window.process && window.process.type) delete window.process } catch (_) {}
  } catch (e) {
    console.error('[preload] spoofBrowserEnv error:', e.message)
  }
})()

function normalizeUrl(raw) {
  const s = raw.trim()
  if (!s) return null
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(s)) return s
  if (/\s/.test(s) || !/\./.test(s)) return 'https://www.google.com/search?q=' + encodeURIComponent(s)
  return 'https://' + s
}

function injectNavBar() {
  if (document.getElementById('_gm_navbar')) return

  const bar = document.createElement('div')
  bar.id = '_gm_navbar'
  bar.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'height:36px',
    'background:#1a1a1a', 'display:flex', 'align-items:center',
    'gap:4px', 'padding:0 8px', 'z-index:2147483647',
    'box-sizing:border-box', 'font-family:system-ui,sans-serif',
  ].join(';')

  const btnStyle = [
    'background:#333', 'color:#ccc', 'border:none', 'border-radius:4px',
    'width:28px', 'height:24px', 'cursor:pointer', 'font-size:14px',
    'display:flex', 'align-items:center', 'justify-content:center',
    'flex-shrink:0',
  ].join(';')

  const back = document.createElement('button')
  back.textContent = '\u2039'
  back.title = 'Back'
  back.style.cssText = btnStyle
  back.onclick = () => ipcRenderer.send('nav-back')

  const fwd = document.createElement('button')
  fwd.textContent = '\u203a'
  fwd.title = 'Forward'
  fwd.style.cssText = btnStyle
  fwd.onclick = () => ipcRenderer.send('nav-forward')

  const input = document.createElement('input')
  input.id = '_gm_navbar_url'
  input.type = 'text'
  input.value = location.href
  input.style.cssText = [
    'flex:1', 'height:24px', 'background:#2a2a2a', 'color:#eee',
    'border:1px solid #444', 'border-radius:4px', 'padding:0 8px',
    'font-size:13px', 'outline:none', 'box-sizing:border-box',
  ].join(';')
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go()
  })

  const goBtn = document.createElement('button')
  goBtn.textContent = 'Go'
  goBtn.style.cssText = [
    'background:#0066cc', 'color:#fff', 'border:none', 'border-radius:4px',
    'padding:0 10px', 'height:24px', 'cursor:pointer', 'font-size:13px',
    'flex-shrink:0',
  ].join(';')
  goBtn.onclick = go

  function go() {
    const url = normalizeUrl(input.value)
    if (url) ipcRenderer.send('nav-go', url)
  }

  bar.appendChild(back)
  bar.appendChild(fwd)
  bar.appendChild(input)
  bar.appendChild(goBtn)
  document.documentElement.prepend(bar)

  const style = document.createElement('style')
  style.id = '_gm_navbar_style'
  style.textContent = 'html { margin-top: 36px !important; box-sizing: border-box !important; } body { margin-top: 0 !important; } ytd-app { padding-top: 0 !important; }'
  ;(document.head || document.documentElement).appendChild(style)

  const obs = new MutationObserver(() => {
    if (!document.getElementById('_gm_navbar')) document.documentElement.prepend(bar)
    if (!document.getElementById('_gm_navbar_style')) {
      ;(document.head || document.documentElement).appendChild(style)
    }
  })
  obs.observe(document.documentElement, { childList: true, subtree: false })

  window.addEventListener('popstate', () => {
    const el = document.getElementById('_gm_navbar_url')
    if (el) el.value = location.href
  })
}

function injectYoutubeAdSkip() {
  if (!location.hostname.includes('youtube.com')) return
  const SELECTORS = ['.ytp-skip-ad-button', '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern']
  function trySkip() {
    for (const sel of SELECTORS) {
      const btn = document.querySelector(sel)
      if (btn) { btn.click(); return }
    }
    const video = document.querySelector('.ad-showing video')
    if (video && video.duration && isFinite(video.duration)) video.currentTime = video.duration
  }
  const obs = new MutationObserver(trySkip)
  obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
  trySkip()
}

function injectAll() {
  injectNavBar()
  injectYoutubeAdSkip()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectAll)
} else {
  injectAll()
}

window.addEventListener('load', () => {
  injectAll()
  const el = document.getElementById('_gm_navbar_url')
  if (el) el.value = location.href
})

const _OrigAudioContext = window.AudioContext || window.webkitAudioContext
const _pageContexts = new Set()
const _AudioContextProxy = function AudioContext(opts) {
  const ctx = new _OrigAudioContext(opts)
  _pageContexts.add(ctx)
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}
_AudioContextProxy.prototype = _OrigAudioContext.prototype
window.AudioContext = _AudioContextProxy
if (window.webkitAudioContext) window.webkitAudioContext = _AudioContextProxy

ipcRenderer.on('start-capture', () => startCapture())
ipcRenderer.on('reset-capture', () => {
  captureGen++
  if (captureCtx) { captureCtx.close().catch(() => {}); captureCtx = null }
  workletNode = null
})

if (!location.href.startsWith('chrome-error://') && !location.href.startsWith('devtools://')) {
  startCapture()
}

let _ctxSeq = 0
async function buildCaptureGraph() {
  const ctx = new _OrigAudioContext({ sampleRate: SAMPLE_RATE })
  ctx.__id = ++_ctxSeq
  captureCtx = ctx
  await ctx.resume().catch(() => {})

  const preloadDir = (process.argv.find(a => a.startsWith('--preload-dir=')) || '').slice('--preload-dir='.length)
  const workletUrl = 'file:///' + preloadDir.replace(/\\/g, '/') + '/capture-worklet.js'
  await ctx.audioWorklet.addModule(workletUrl)

  const node = new AudioWorkletNode(ctx, 'capture-processor')
  workletNode = node
  let _count = 0
  node.port.onmessage = (e) => {
    _count++
    if (_count <= 3 || _count % 500 === 0) ipcRenderer.send('log', '[capture] frame #' + _count)
    ipcRenderer.send('audio-pcm', e.data)
  }

  const silencer = ctx.createGain()
  silencer.gain.value = 0
  node.connect(silencer)
  silencer.connect(ctx.destination)

  const osc = ctx.createOscillator()
  const oscGain = ctx.createGain()
  oscGain.gain.value = 0
  osc.connect(oscGain)
  oscGain.connect(node)
  osc.start()

  return ctx
}

function connectMediaEl(el) {
  if (!captureCtx || captureCtx.state === 'closed' || !workletNode) return
  if (el._gmCtxId === captureCtx.__id) return
  el._gmCtxId = captureCtx.__id
  try {
    const src = captureCtx.createMediaElementSource(el)
    src.connect(workletNode)
    ipcRenderer.send('log', '[capture] media element connected: ' + (el.src || el.currentSrc || 'unknown').slice(0, 80))
  } catch (e) {
    ipcRenderer.send('log', '[capture] media element connect failed: ' + e.message)
  }
}

function patchAudioNodeConnect() {
  const _orig = AudioNode.prototype.connect
  AudioNode.prototype.connect = function(target, outIdx, inIdx) {
    const r = outIdx !== undefined ? _orig.call(this, target, outIdx, inIdx !== undefined ? inIdx : 0) : _orig.call(this, target)
    if (target instanceof AudioDestinationNode && workletNode) {
      try { _orig.call(this, workletNode, outIdx !== undefined ? outIdx : 0) } catch (_) {}
    }
    return r
  }
}

function scanMediaElements() {
  document.querySelectorAll('video, audio').forEach(connectMediaEl)
}

function observeMediaElements() {
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue
        if (node.matches && node.matches('video, audio')) connectMediaEl(node)
        node.querySelectorAll && node.querySelectorAll('video, audio').forEach(connectMediaEl)
      }
    }
  })
  obs.observe(document.documentElement, { childList: true, subtree: true })
}

async function startCapture() {
  captureGen++
  const gen = captureGen

  if (captureCtx) { captureCtx.close().catch(() => {}); captureCtx = null; workletNode = null }

  try {
    await buildCaptureGraph()
  } catch (e) {
    ipcRenderer.send('log', '[capture] buildCaptureGraph failed: ' + e.message)
    return
  }
  if (captureGen !== gen) return
  patchAudioNodeConnect()
  for (const ctx of _pageContexts) {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  }

  const rescan = setInterval(() => {
    if (captureGen !== gen) { clearInterval(rescan); return }
    scanMediaElements()
  }, 2000)

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (captureGen === gen) { scanMediaElements(); observeMediaElements() }
    })
  } else {
    scanMediaElements()
    observeMediaElements()
  }

  ipcRenderer.send('log', '[capture] active (web-audio + media-element intercept)')
}

let _inboundCtx = null, _inboundNext = 0
ipcRenderer.on('audio-inbound', (_, arrayBuffer) => {
  const buf = Buffer.isBuffer(arrayBuffer) ? arrayBuffer : Buffer.from(arrayBuffer)
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  if (f32.length === 0 || f32.length % 2 !== 0) return
  if (!_inboundCtx) _inboundCtx = new _OrigAudioContext({ sampleRate: 48000 })
  if (_inboundCtx.state === 'suspended') _inboundCtx.resume().catch(() => {})
  const frames = f32.length / 2
  const ab = _inboundCtx.createBuffer(2, frames, 48000)
  const L = ab.getChannelData(0), R = ab.getChannelData(1)
  for (let i = 0; i < frames; i++) { L[i] = f32[i * 2]; R[i] = f32[i * 2 + 1] }
  const src = _inboundCtx.createBufferSource()
  src.buffer = ab; src.connect(_inboundCtx.destination)
  const now = _inboundCtx.currentTime
  if (_inboundNext < now) _inboundNext = now
  src.start(_inboundNext); _inboundNext += frames / 48000
})
