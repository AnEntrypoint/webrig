import dotenv from 'dotenv'
dotenv.config()

import Hyperswarm from 'hyperswarm'
import { createHash } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'

const SWARM_TOPIC = process.env.SWARM_TOPIC || ''
const CDP_PROXY_PORT = parseInt(process.env.CDP_PROXY_PORT || '9230', 10)
const MSG = { CDP_UP: 3, CDP_DOWN: 4 }

if (!SWARM_TOPIC) {
  console.error('Usage: SWARM_TOPIC=<topic> CDP_PROXY_PORT=<port> node src/p2p/client.js')
  process.exit(1)
}

function encode(type, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const out = Buffer.allocUnsafe(8 + buf.length)
  out.writeUInt32LE(type, 0)
  out.writeUInt32LE(buf.length, 4)
  buf.copy(out, 8)
  return out
}

const topic = createHash('sha256').update(SWARM_TOPIC).digest()
const sw = new Hyperswarm()
let swarmConn = null
let recvBuf = Buffer.alloc(0)
const wsClients = new Map()

function processRecvBuf() {
  while (recvBuf.length >= 8) {
    const type = recvBuf.readUInt32LE(0)
    const len = recvBuf.readUInt32LE(4)
    if (recvBuf.length < 8 + len) break
    const payload = recvBuf.slice(8, 8 + len)
    recvBuf = recvBuf.slice(8 + len)
    if (type === MSG.CDP_DOWN) {
      for (const ws of wsClients.values()) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload)
      }
    }
  }
}

sw.on('connection', (conn) => {
  swarmConn = conn
  recvBuf = Buffer.alloc(0)
  console.log('[headless] swarm host connected')
  conn.on('data', (chunk) => {
    recvBuf = Buffer.concat([recvBuf, chunk])
    processRecvBuf()
  })
  conn.on('error', () => {})
  conn.on('close', () => {
    swarmConn = null
    console.log('[headless] swarm host disconnected')
  })
})

sw.on('error', (err) => console.error('[headless] swarm error:', err.message))

const wss = new WebSocketServer({ port: CDP_PROXY_PORT, host: '127.0.0.1' })
wss.on('connection', (ws) => {
  const sid = Symbol()
  wsClients.set(sid, ws)
  ws.on('message', (data) => {
    if (!swarmConn || swarmConn.destroyed) return
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    swarmConn.write(encode(MSG.CDP_UP, buf))
  })
  ws.on('close', () => wsClients.delete(sid))
  ws.on('error', () => {})
})
wss.on('error', (err) => console.error('[headless] wss error:', err.message))
wss.on('listening', () => console.log(`[headless] CDP proxy on ws://127.0.0.1:${CDP_PROXY_PORT}`))

await sw.join(topic, { client: true, server: true }).flushed()
console.log('[headless] joined swarm topic, waiting for host...')

process.on('SIGINT', () => { sw.destroy().catch(() => {}); wss.close(); process.exit(0) })
process.on('SIGTERM', () => { sw.destroy().catch(() => {}); wss.close(); process.exit(0) })
