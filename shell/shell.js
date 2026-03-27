import { GoogleGenAI } from 'https://esm.sh/@google/genai@1.46.0'

const SW_PATH = '../bridge-sw.js'
const RPC_URL = 'ws://127.0.0.1:9377'
const GEMINI_MODEL = 'gemini-2.0-flash'
const ANTHROPIC_MODEL = 'claude-opus-4-6'

const $ = id => document.getElementById(id)
const stor = { get: k => localStorage.getItem(k) || '', set: (k,v) => localStorage.setItem(k,v) }

function stripAnsi(s) { return s.replace(/\x1B\[[0-9;]*[mGKHF]/g,'').replace(/\x1B\][^\x07]*\x07/g,'') }

function appendLine(text, kind = 'raw') {
  const out = $('output')
  const div = document.createElement('div')
  div.className = 'line line-' + kind
  div.textContent = stripAnsi(text)
  out.appendChild(div); out.scrollTop = out.scrollHeight
}

function clearOutput() { $('output').innerHTML = '' }

async function registerSW() {
  if (!navigator.serviceWorker) return
  try {
    await navigator.serviceWorker.register(SW_PATH, { scope: '/' })
    navigator.serviceWorker.controller?.postMessage({ type: 'BRIDGE_CONFIG', config: loadKeys() })
  } catch {}
}

function loadKeys() {
  return { anthropicApiKey: stor.get('anthropicKey'), openaiApiKey: stor.get('openaiKey'),
           openrouterApiKey: stor.get('openrouterKey'), geminiApiKey: stor.get('geminiKey') }
}

function saveKeys() {
  stor.set('anthropicKey', $('key-anthropic').value.trim())
  stor.set('openaiKey', $('key-openai').value.trim())
  stor.set('openrouterKey', $('key-openrouter').value.trim())
  stor.set('geminiKey', $('key-gemini').value.trim())
  navigator.serviceWorker.controller?.postMessage({ type: 'BRIDGE_CONFIG', config: loadKeys() })
  appendLine('API keys saved.', 'info')
}

async function runGemini(prompt) {
  const key = stor.get('geminiKey')
  if (!key) { appendLine('Gemini API key required — enter in Settings.', 'err'); return }
  appendLine('you: ' + prompt, 'user')
  const ai = new GoogleGenAI({ apiKey: key })
  const stream = await ai.models.generateContentStream({ model: GEMINI_MODEL, contents: prompt })
  let buf = ''
  const div = document.createElement('div'); div.className = 'line line-assistant'; $('output').appendChild(div)
  for await (const chunk of stream) {
    buf += chunk.text || ''; div.textContent = buf; $('output').scrollTop = $('output').scrollHeight
  }
}

async function runAnthropic(prompt) {
  appendLine('you: ' + prompt, 'user')
  const key = stor.get('anthropicKey')
  const body = { model: ANTHROPIC_MODEL, max_tokens: 4096, stream: true, messages: [{ role: 'user', content: prompt }] }
  const headers = { 'Content-Type': 'application/json' }
  if (key) headers['x-api-key'] = key
  const resp = await fetch('/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) })
  if (!resp.ok) { appendLine('Anthropic error: ' + resp.status, 'err'); return }
  const div = document.createElement('div'); div.className = 'line line-assistant'; $('output').appendChild(div)
  const reader = resp.body.getReader(); const dec = new TextDecoder()
  let buf = '', text = ''
  while (true) {
    const { done, value } = await reader.read(); if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try { const evt = JSON.parse(line.slice(6)); if (evt.delta?.type === 'text_delta') { text += evt.delta.text; div.textContent = text; $('output').scrollTop = $('output').scrollHeight } } catch {}
    }
  }
}

const companion = (() => {
  let ws = null, id = 0, pending = new Map(), subs = new Map(), status = 'disconnected'
  const onStatus = new Set()
  function setStatus(s) { status = s; onStatus.forEach(fn => fn(s)) }
  function connect() {
    if (ws) return
    ws = new WebSocket(RPC_URL); setStatus('connecting')
    ws.onopen = () => setStatus('connected')
    ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.stream && subs.has(msg.sessionId)) { subs.get(msg.sessionId)(msg.event); return }
        if (msg.id != null && pending.has(msg.id)) { const {resolve,reject}=pending.get(msg.id); pending.delete(msg.id); msg.error?reject(new Error(msg.error)):resolve(msg.result) }
      } catch {}
    }
    ws.onclose = () => { ws = null; setStatus('disconnected'); setTimeout(connect, 3000) }
    ws.onerror = () => {}
  }
  function call(method, params) {
    return new Promise((resolve, reject) => {
      if (status !== 'connected') return reject(new Error('companion offline'))
      const rid = ++id; pending.set(rid, { resolve, reject })
      ws.send(JSON.stringify({ id: rid, method, params }))
      setTimeout(() => { if (pending.has(rid)) { pending.delete(rid); reject(new Error('timeout')) } }, 30000)
    })
  }
  return { connect, call, subscribe: (sid, fn) => subs.set(sid, fn), unsubscribe: sid => subs.delete(sid),
           onStatus: fn => { onStatus.add(fn); fn(status); return () => onStatus.delete(fn) }, get status() { return status } }
})()

async function runCli(agent, prompt) {
  if (companion.status !== 'connected') { appendLine('Companion offline — run: npx webrig (or webrig if installed)', 'err'); return }
  appendLine('you: ' + prompt, 'user')
  appendLine('[spawning ' + agent + '…]', 'info')
  const info = await companion.call('acp.sessions.new', { agent, cwd: stor.get('cwd') || undefined })
  companion.subscribe(info.id, evt => {
    if (evt.type === 'stderr') appendLine(evt.text, 'err')
    else if (evt.type === 'session_closed') { appendLine('[' + agent + ' exited ' + evt.code + ']', 'info'); companion.unsubscribe(info.id) }
    else if (evt.type === 'acp_event') {
      const d = evt.data
      if (d?.method === 'session/update' && d.params?.message?.content)
        d.params.message.content.filter(b => b.type === 'text').forEach(b => appendLine(b.text, 'assistant'))
      else if (d?.method === 'tools/call') appendLine('[tool: ' + (d.params?.name || '?') + ']', 'tool')
      else appendLine(JSON.stringify(d).slice(0, 200), 'raw')
    }
  })
  try { await companion.call('acp.prompt', { sessionId: info.id, text: prompt }) } catch (e) { appendLine(e.message, 'err') }
}

async function handleSubmit() {
  const input = $('input')
  const prompt = input.value.trim(); if (!prompt) return
  input.value = ''; clearOutput()
  try {
    const agent = $('agent-select').value
    if (agent === 'gemini') await runGemini(prompt)
    else if (agent === 'anthropic') await runAnthropic(prompt)
    else await runCli(agent, prompt)
  } catch (e) { appendLine('Error: ' + e.message, 'err') }
}

function init() {
  registerSW()
  companion.connect()
  companion.onStatus(s => { const el = $('companion-status'); el.textContent = s; el.className = 'status-dot status-' + s })
  const keys = loadKeys()
  $('key-anthropic').value = keys.anthropicApiKey; $('key-openai').value = keys.openaiApiKey
  $('key-openrouter').value = keys.openrouterApiKey; $('key-gemini').value = keys.geminiApiKey
  $('save-keys').onclick = saveKeys
  $('input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit() } })
  $('send-btn').onclick = handleSubmit
  $('clear-btn').onclick = clearOutput
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
      btn.classList.add('active'); $(btn.dataset.tab).classList.add('active')
    }
  })
  appendLine('webrig shell ready. Select an agent and type a prompt.', 'info')
}

document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init()
