const browser = globalThis.browser || globalThis.chrome
const btn = document.getElementById('btn')
const urlInput = document.getElementById('wsUrl')
const statusEl = document.getElementById('status')

let capturing = false

function setUI(isCapturing) {
  capturing = isCapturing
  btn.textContent = isCapturing ? 'Stop' : 'Start'
  statusEl.textContent = isCapturing ? 'Capturing' : 'Idle'
}

browser.storage.local.get(['wsUrl']).then((result) => {
  urlInput.value = result.wsUrl || 'ws://127.0.0.1:9888'
})

browser.runtime.sendMessage({ type: 'STATUS' }).then((res) => {
  if (res) setUI(res.capturing)
}).catch(() => {})

btn.addEventListener('click', () => {
  const wsUrl = urlInput.value.trim() || 'ws://127.0.0.1:9888'
  browser.storage.local.set({ wsUrl })

  if (!capturing) {
    statusEl.textContent = 'Starting...'
    browser.runtime.sendMessage({ type: 'START', wsUrl }).then((res) => {
      if (res?.ok) setUI(true)
      else statusEl.textContent = 'Error: ' + (res?.error || 'unknown')
    }).catch((e) => { statusEl.textContent = 'Error: ' + e.message })
  } else {
    statusEl.textContent = 'Stopping...'
    browser.runtime.sendMessage({ type: 'STOP' }).then((res) => {
      if (res?.ok) setUI(false)
      else statusEl.textContent = 'Error: ' + (res?.error || 'unknown')
    }).catch((e) => { statusEl.textContent = 'Error: ' + e.message })
  }
})
