import { WebSocketServer, WebSocket } from 'ws'
import { sendCdpUp, sendCdpDown } from './swarm.js'

let wss = null
let clientSockets = new Map()
let peerHostSockets = new Map()
let _cdpPort = null

async function _fetchDebuggerUrl(cdpPort) {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
  const json = await res.json()
  return json.webSocketDebuggerUrl.replace('ws://localhost', 'ws://127.0.0.1')
}

async function _connectPeerHostSocket(cdpPort, conn) {
  let url
  for (let i = 0; i < 20; i++) {
    try { url = await _fetchDebuggerUrl(cdpPort); break } catch { await new Promise(r => setTimeout(r, 500)) }
  }
  if (!url) { console.error('[cdp-proxy] could not get debugger URL'); return }
  const hs = new WebSocket(url)
  peerHostSockets.set(conn, hs)
  hs.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    sendCdpDown(buf, conn)
  })
  hs.on('error', () => {})
  hs.on('close', () => {
    peerHostSockets.delete(conn)
    if (_cdpPort && !conn.destroyed) setTimeout(() => _connectPeerHostSocket(_cdpPort, conn), 2000)
  })
  hs.on('open', () => console.log('[cdp-proxy] connected to CDP server for peer'))
}

function onPeerConnect(conn) {
  if (_cdpPort) _connectPeerHostSocket(_cdpPort, conn)
}

function onPeerDisconnect(conn) {
  const hs = peerHostSockets.get(conn)
  if (hs) { try { hs.close() } catch {}; peerHostSockets.delete(conn) }
}

function startHostProxy(cdpPort) {
  _cdpPort = cdpPort
}

function startClientProxy(proxyPort) {
  wss = new WebSocketServer({ port: proxyPort, host: '127.0.0.1' })
  wss.on('connection', (ws) => {
    const sid = Symbol()
    clientSockets.set(sid, ws)
    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      sendCdpUp(buf)
    })
    ws.on('close', () => clientSockets.delete(sid))
    ws.on('error', () => {})
  })
  wss.on('error', (err) => console.error('[cdp-proxy] client wss error:', err.message))
  console.log(`[cdp-proxy] client proxy listening on ws://127.0.0.1:${proxyPort}`)
}

function onSwarmCdpUp(buf, conn) {
  const hs = peerHostSockets.get(conn)
  if (hs && hs.readyState === WebSocket.OPEN) hs.send(buf)
}

function onSwarmCdpDown(buf) {
  for (const ws of clientSockets.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(buf)
  }
}

function startCdpProxy(role, cdpPort, proxyPort) {
  if (role === 'host') startHostProxy(cdpPort)
  else startClientProxy(proxyPort)
}

function stopCdpProxy() {
  _cdpPort = null
  if (wss) { wss.close(); wss = null }
  for (const hs of peerHostSockets.values()) { try { hs.close() } catch {} }
  peerHostSockets.clear()
  clientSockets.clear()
}

export { startCdpProxy, stopCdpProxy, onSwarmCdpUp, onSwarmCdpDown, onPeerConnect, onPeerDisconnect }
