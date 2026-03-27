let _iframe = null
let _currentUrl = ''

export function initBrowser(el) { _iframe = el }
export function getCurrentUrl() { return _currentUrl }

export function navigate(url) {
  if (!_iframe) return Promise.resolve('no iframe')
  _currentUrl = url
  return new Promise(resolve => {
    _iframe.onload = () => resolve('navigated: ' + url)
    _iframe.onerror = () => resolve('load error: ' + url)
    _iframe.src = url
    setTimeout(() => resolve('timeout: ' + url), 15000)
  })
}

function getDoc() { try { return _iframe?.contentDocument } catch { return null } }

export function snapshot() {
  const doc = getDoc()
  if (!doc) return 'cross-origin — use CDP or load via proxy'
  const els = doc.querySelectorAll('a,button,input,select,textarea,[role=button],[onclick]')
  const items = []; let i = 0
  els.forEach(el => {
    if (!el.offsetParent && el.tagName !== 'INPUT') return
    i++; el.dataset.wRef = 'r' + i
    const tag = el.tagName.toLowerCase()
    const txt = (el.textContent||'').trim().slice(0,60)
    const val = el.value ? ' val="'+el.value.slice(0,30)+'"' : ''
    const href = el.href ? ' href="'+el.href.slice(0,60)+'"' : ''
    items.push('@r'+i+' ['+tag+href+val+']'+(txt?' "'+txt+'"':''))
  })
  return items.length ? items.join('
') : 'no interactive elements'
}

export function click(ref) {
  const doc = getDoc(); if (!doc) return 'cross-origin'
  const el = ref.startsWith('@') ? doc.querySelector('[data-w-ref="'+ref.slice(1)+'"]') : doc.querySelector(ref)
  if (!el) return 'not found: ' + ref
  el.click(); return 'clicked: ' + (el.textContent||el.tagName).trim().slice(0,40)
}

export function fill(ref, text) {
  const doc = getDoc(); if (!doc) return 'cross-origin'
  const el = ref.startsWith('@') ? doc.querySelector('[data-w-ref="'+ref.slice(1)+'"]') : doc.querySelector(ref)
  if (!el) return 'not found: ' + ref
  el.value = text
  el.dispatchEvent(new Event('input',{bubbles:true}))
  el.dispatchEvent(new Event('change',{bubbles:true}))
  return 'filled: ' + (el.name||el.id||el.tagName)
}

export function evalJs(code) {
  try { return String(_iframe?.contentWindow?.eval(code)||'').slice(0,4000) }
  catch(e) { return 'eval error: ' + e.message }
}

export function renderBrowserPanel(urlInput, goBtn, snapBtn, frameEl) {
  initBrowser(frameEl)
  goBtn.onclick = async () => {
    const url = urlInput.value.trim(); if (!url) return
    goBtn.textContent = '…'
    await navigate(url.startsWith('http') ? url : 'https://' + url)
    goBtn.textContent = 'Go'
  }
  snapBtn.onclick = () => { const r = snapshot(); alert(r.slice(0,2000)) }
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') goBtn.click() })
}
