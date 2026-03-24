const btn = document.getElementById('btn')
const urlInput = document.getElementById('wsUrl')
const cdpInput = document.getElementById('cdpUrl')
const statusEl = document.getElementById('status')
const cdpStatusEl = document.getElementById('cdpStatus')

let capturing = false

function setUI(isCapturing, cdpAttached) {
  capturing = isCapturing
  btn.textContent = isCapturing ? 'Stop' : 'Start'
  statusEl.textContent = isCapturing ? 'Capturing' : 'Idle'
  cdpStatusEl.textContent = cdpAttached ? 'Attached' : 'Detached'
}

chrome.storage.local.get(['wsUrl', 'cdpWsUrl'], (result) => {
  urlInput.value = result.wsUrl || 'ws://127.0.0.1:9888'
  cdpInput.value = result.cdpWsUrl || 'ws://127.0.0.1:9231'
})

chrome.runtime.sendMessage({ type: 'STATUS' }, (res) => {
  if (res) setUI(res.capturing, res.cdpAttached || false)
})

btn.addEventListener('click', () => {
  const wsUrl = urlInput.value.trim() || 'ws://127.0.0.1:9888'
  const cdpWsUrl = cdpInput.value.trim() || 'ws://127.0.0.1:9231'
  chrome.storage.local.set({ wsUrl, cdpWsUrl })

  if (!capturing) {
    statusEl.textContent = 'Starting...'
    chrome.runtime.sendMessage({ type: 'START', wsUrl, cdpWsUrl }, (res) => {
      if (res?.ok) {
        setUI(true, false)
      } else {
        statusEl.textContent = 'Error: ' + (res?.error || 'unknown')
      }
    })
  } else {
    statusEl.textContent = 'Stopping...'
    chrome.runtime.sendMessage({ type: 'STOP' }, (res) => {
      if (res?.ok) setUI(false, false)
      else statusEl.textContent = 'Error: ' + (res?.error || 'unknown')
    })
  }
})
