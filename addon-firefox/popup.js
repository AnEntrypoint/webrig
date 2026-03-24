const api = typeof browser !== 'undefined' ? browser : chrome

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

api.storage.local.get(['wsUrl', 'cdpWsUrl']).then((result) => {
  urlInput.value = result.wsUrl || 'ws://127.0.0.1:9888'
  cdpInput.value = result.cdpWsUrl || 'ws://127.0.0.1:9231'
})

api.runtime.sendMessage({ type: 'STATUS' }).then((res) => {
  if (res) setUI(res.capturing, res.cdpAttached || false)
}).catch(() => {})

btn.addEventListener('click', () => {
  const wsUrl = urlInput.value.trim() || 'ws://127.0.0.1:9888'
  const cdpWsUrl = cdpInput.value.trim() || 'ws://127.0.0.1:9231'
  api.storage.local.set({ wsUrl, cdpWsUrl })

  if (!capturing) {
    statusEl.textContent = 'Starting...'
    api.runtime.sendMessage({ type: 'START', wsUrl, cdpWsUrl }).then((res) => {
      if (res?.ok) {
        setUI(true, false)
      } else {
        statusEl.textContent = 'Error: ' + (res?.error || 'unknown')
      }
    }).catch((e) => {
      statusEl.textContent = 'Error: ' + e.message
    })
  } else {
    statusEl.textContent = 'Stopping...'
    api.runtime.sendMessage({ type: 'STOP' }).then((res) => {
      if (res?.ok) setUI(false, false)
      else statusEl.textContent = 'Error: ' + (res?.error || 'unknown')
    }).catch((e) => {
      statusEl.textContent = 'Error: ' + e.message
    })
  }
})
