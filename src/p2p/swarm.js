import Hyperswarm from 'hyperswarm'
import { createHash } from 'node:crypto'

const MSG = { AUDIO: 1, FRAME: 2, CDP_UP: 3, CDP_DOWN: 4, INPUT: 5 }

let swarm = null
let peers = new Map()
let peerSeq = 0
let callbacks = {}

function _hashTopic(str) {
  return createHash('sha256').update(str).digest()
}

function _encode(type, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const out = Buffer.allocUnsafe(8 + buf.length)
  out.writeUInt32LE(type, 0)
  out.writeUInt32LE(buf.length, 4)
  buf.copy(out, 8)
  return out
}

function _sendTo(conn, type, payload) {
  if (!conn || conn.destroyed) return
  try { conn.write(_encode(type, payload)) } catch {}
}

function _processRecvBuf(state) {
  while (state.recvBuf.length >= 8) {
    const type = state.recvBuf.readUInt32LE(0)
    const len = state.recvBuf.readUInt32LE(4)
    if (state.recvBuf.length < 8 + len) break
    const payload = state.recvBuf.slice(8, 8 + len)
    state.recvBuf = state.recvBuf.slice(8 + len)
    _dispatch(type, payload, state.conn)
  }
}

function _dispatch(type, payload, conn) {
  if (type === MSG.AUDIO && callbacks.onAudio) {
    const f32 = new Float32Array(payload.buffer, payload.byteOffset, payload.byteLength / 4)
    callbacks.onAudio(f32)
  } else if (type === MSG.FRAME && callbacks.onFrame) {
    callbacks.onFrame(payload)
  } else if (type === MSG.CDP_UP && callbacks.onCdpUp) {
    callbacks.onCdpUp(payload, conn)
  } else if (type === MSG.CDP_DOWN && callbacks.onCdpDown) {
    callbacks.onCdpDown(payload, conn)
  } else if (type === MSG.INPUT && callbacks.onInput) {
    try { callbacks.onInput(JSON.parse(payload.toString())) } catch {}
  }
}

function _attachPeer(conn) {
  const id = ++peerSeq
  const state = { conn, recvBuf: Buffer.alloc(0), id }
  peers.set(id, state)
  conn.on('data', (chunk) => {
    state.recvBuf = Buffer.concat([state.recvBuf, chunk])
    _processRecvBuf(state)
  })
  conn.on('error', () => {})
  conn.on('close', () => {
    peers.delete(id)
    if (callbacks.onDisconnect) callbacks.onDisconnect(conn)
  })
  if (callbacks.onConnect) callbacks.onConnect(conn)
}

async function startSwarm(topicStr, role, cbs) {
  callbacks = cbs || {}
  swarm = new Hyperswarm()
  const topic = _hashTopic(topicStr)
  swarm.on('connection', (conn) => _attachPeer(conn))
  swarm.on('error', (err) => console.error('[swarm] error:', err.message))
  await swarm.join(topic, { client: true, server: true }).flushed()
  console.log(`[swarm] joined topic as ${role}`)
}

function destroySwarm() {
  if (swarm) {
    swarm.destroy().catch(() => {})
    swarm = null
    peers.clear()
  }
}

function sendAudio(f32) {
  const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
  for (const { conn } of peers.values()) _sendTo(conn, MSG.AUDIO, buf)
}

function sendFrame(jpegBuf) {
  for (const { conn } of peers.values()) _sendTo(conn, MSG.FRAME, jpegBuf)
}

function sendInput(eventObj) {
  const buf = Buffer.from(JSON.stringify(eventObj))
  for (const { conn } of peers.values()) _sendTo(conn, MSG.INPUT, buf)
}

function sendCdpUp(buf, conn) {
  if (conn) { _sendTo(conn, MSG.CDP_UP, buf); return }
  for (const p of peers.values()) _sendTo(p.conn, MSG.CDP_UP, buf)
}

function sendCdpDown(buf, conn) {
  if (conn) { _sendTo(conn, MSG.CDP_DOWN, buf); return }
  for (const p of peers.values()) _sendTo(p.conn, MSG.CDP_DOWN, buf)
}

export { startSwarm, destroySwarm, sendAudio, sendFrame, sendInput, sendCdpUp, sendCdpDown }
