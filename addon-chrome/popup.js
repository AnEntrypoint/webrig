const btn = document.getElementById('btn')
const urlInput = document.getElementById('wsUrl')
const cdpInput = document.getElementById('cdpUrl')
const statusEl = document.getElementById('status')
const cdpStatusEl = document.getElementById('cdpStatus')
const targetTitleEl = document.getElementById('targetTitle')
const tabsListEl = document.getElementById('tabsList')
let capturing = false

function setUI(isCapturing, cdpAttached) {
  capturing = isCapturing
  btn.textContent = isCapturing ? 'Stop' : 'Start'
  statusEl.textContent = isCapturing ? 'Capturing' : 'Idle'
  cdpStatusEl.textContent = cdpAttached ? 'Attached' : 'Detached'
}

function renderTabs(tabs, currentTarget) {
  tabsListEl.innerHTML = ''
  tabs.forEach(t => {
    const row = document.createElement('div')
    row.className = 'tab-row' + (t.id === currentTarget ? ' active' : '')
    const img = document.createElement('img')
    img.src = t.favIconUrl || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'
    img.onerror = () => { img.style.display = 'none' }
    const span = document.createElement('span')
    span.className = 'tab-title'
    span.textContent = t.title || t.url
    row.appendChild(img); row.appendChild(span)
    row.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'SET_TARGET_TAB', tabId: t.id }, () => loadTabs())
    })
    tabsListEl.appendChild(row)
  })
}

function loadTabs() {
  chrome.runtime.sendMessage({ type: 'TABS_LIST' }, (tabs) => {
    chrome.runtime.sendMessage({ type: 'GET_TARGET' }, ({ targetTabId }) => {
      targetTitleEl.textContent = tabs.find(t => t.id === targetTabId)?.title || 'none'
      renderTabs(tabs, targetTabId)
    })
  })
}

chrome.storage.local.get(['wsUrl', 'cdpWsUrl'], (result) => {
  urlInput.value = result.wsUrl || 'ws://127.0.0.1:9888'
  cdpInput.value = result.cdpWsUrl || 'ws://127.0.0.1:9231'
})
chrome.runtime.sendMessage({ type: 'STATUS' }, (res) => { if (res) setUI(res.capturing, res.cdpAttached || false) })
loadTabs()

btn.addEventListener('click', () => {
  const wsUrl = urlInput.value.trim() || 'ws://127.0.0.1:9888'
  const cdpWsUrl = cdpInput.value.trim() || 'ws://127.0.0.1:9231'
  chrome.storage.local.set({ wsUrl, cdpWsUrl })
  if (!capturing) {
    statusEl.textContent = 'Starting...'
    chrome.runtime.sendMessage({ type: 'START', wsUrl, cdpWsUrl }, (res) => {
      if (res?.ok) setUI(true, false)
      else statusEl.textContent = 'Error: ' + (res?.error || 'unknown')
    })
  } else {
    statusEl.textContent = 'Stopping...'
    chrome.runtime.sendMessage({ type: 'STOP' }, (res) => {
      if (res?.ok) setUI(false, false)
      else statusEl.textContent = 'Error: ' + (res?.error || 'unknown')
    })
  }
})