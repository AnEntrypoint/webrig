import 'dotenv/config'
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { createClient, joinDiscordVoice, subscribeToSpeaker } from '../src/bot/client.js'
import { initVoicePlayer, pushAudioFrame } from '../src/bot/voice.js'
import { MSG, encode, startSwarm, sendFrame, sendInput, sendAudio } from '../src/p2p/swarm.js'

const WS_AUDIO_PORT = parseInt(process.env.WS_AUDIO_PORT ?? '9888')
const CDP_PROXY_PORT = parseInt(process.env.CDP_PROXY_PORT ?? '9231')
const CDP_BRIDGE_HTTP_PORT = parseInt(process.env.CDP_BRIDGE_HTTP_PORT ?? '9232')
const SWARM_TOPIC = process.env.SWARM_TOPIC
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN
const GUILD_ID = process.env.GUILD_ID
const CHANNEL_ID = process.env.CHANNEL_ID

let extensionWs = null
let extensionCdpWs = null
let agentBrowserSockets = new Set()

function sendToExtension(type, payload) {
  if (extensionWs?.readyState === WebSocket.OPEN) extensionWs.send(encode(type, payload))
}

function sendCdpToExtension(buf) {
  if (extensionCdpWs?.readyState === WebSocket.OPEN) extensionCdpWs.send(buf)
}

function broadcastCdpDown(buf) {
  for (const ws of agentBrowserSockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(buf)
  }
}

function processFrame(type, payload) {
  if (type === MSG.AUDIO) {
    const f32 = new Float32Array(payload.buffer, payload.byteOffset, payload.byteLength / 4)
    pushAudioFrame(f32)
    if (SWARM_TOPIC) sendAudio(f32)
  } else if (type === MSG.FRAME) {
    if (SWARM_TOPIC) sendFrame(payload)
  } else if (type === MSG.INPUT) {
    if (SWARM_TOPIC) sendInput(JSON.parse(payload.toString()))
  } else if (type === MSG.CDP_DOWN) {
    broadcastCdpDown(payload)
  }
}

function attachFraming(ws) {
  let buf = Buffer.alloc(0)
  ws.on('message', (data) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(data) ? data : Buffer.from(data)])
    while (buf.length >= 8) {
      const type = buf.readUInt32LE(0)
      const len = buf.readUInt32LE(4)
      if (buf.length < 8 + len) break
      const payload = buf.slice(8, 8 + len)
      buf = buf.slice(8 + len)
      processFrame(type, payload)
    }
  })
}

const audioWss = new WebSocketServer({ port: WS_AUDIO_PORT, host: '127.0.0.1' })
audioWss.on('connection', (ws) => {
  extensionWs = ws
  attachFraming(ws)
  ws.on('error', () => {})
  ws.on('close', () => { if (extensionWs === ws) extensionWs = null })
  console.log('[companion] extension connected on', WS_AUDIO_PORT)
})
console.log('[companion] audio WS listening on', WS_AUDIO_PORT)

const cdpWss = new WebSocketServer({ noServer: true })
cdpWss.on('connection', (ws) => {
  agentBrowserSockets.add(ws)
  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    sendCdpToExtension(buf)
  })
  ws.on('close', () => agentBrowserSockets.delete(ws))
  ws.on('error', () => {})
  console.log('[companion] agent-browser connected')
})

const cdpHttp = createServer((req, res) => {
  if (req.url === '/json/version' || req.url === '/json') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      Browser: 'companion/1.0',
      'Protocol-Version': '1.3',
      webSocketDebuggerUrl: `ws://127.0.0.1:${CDP_BRIDGE_HTTP_PORT}/devtools/browser/companion`
    }))
  } else if (req.url === '/json/list' || req.url === '/json/targets') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('[]')
  } else {
    res.writeHead(404)
    res.end()
  }
})

cdpHttp.on('upgrade', (req, socket, head) => {
  if (req.url === '/devtools/browser/companion') {
    cdpWss.handleUpgrade(req, socket, head, (ws) => cdpWss.emit('connection', ws))
  } else {
    socket.destroy()
  }
})

cdpHttp.listen(CDP_BRIDGE_HTTP_PORT, '127.0.0.1', () => {
  console.log('[companion] CDP HTTP/WS on', CDP_BRIDGE_HTTP_PORT)
})

const cdpExtWss = new WebSocketServer({ port: CDP_PROXY_PORT, host: '127.0.0.1' })
cdpExtWss.on('connection', (ws) => {
  extensionCdpWs = ws
  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    broadcastCdpDown(buf)
  })
  ws.on('close', () => { if (extensionCdpWs === ws) extensionCdpWs = null })
  ws.on('error', () => {})
  console.log('[companion] extension CDP connected on', CDP_PROXY_PORT)
})
console.log('[companion] CDP ext WS listening on', CDP_PROXY_PORT)

if (SWARM_TOPIC) {
  startSwarm(SWARM_TOPIC, 'companion', {
    onAudio: (f32) => {
      pushAudioFrame(f32)
      sendToExtension(MSG.AUDIO, Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength))
    },
    onFrame: (buf) => sendToExtension(MSG.FRAME, buf),
    onInput: (evt) => sendToExtension(MSG.INPUT, Buffer.from(JSON.stringify(evt))),
    onCdpUp: (buf) => sendCdpToExtension(buf),
    onCdpDown: (buf) => broadcastCdpDown(buf),
  })
  console.log('[companion] Hyperswarm started, topic:', SWARM_TOPIC)
}

if (BOT_TOKEN && GUILD_ID && CHANNEL_ID) {
  const client = createClient()
  client.once('ready', async () => {
    console.log('[companion] Discord bot ready:', client.user.tag)
    try {
      const { voiceConnection, voiceReceiver } = await joinDiscordVoice(client, GUILD_ID, CHANNEL_ID)
      initVoicePlayer(voiceConnection)
      voiceReceiver.speaking.on('start', (userId) => {
        subscribeToSpeaker(userId, (_uid, f32) => {
          const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
          sendToExtension(MSG.AUDIO, buf)
          if (SWARM_TOPIC) sendAudio(f32)
        })
      })
    } catch (err) {
      console.error('[companion] voice join failed:', err.message)
    }
  })
  client.on('error', (err) => console.error('[companion] discord error:', err.message))
  client.login(BOT_TOKEN).catch((err) => console.error('[companion] login failed:', err.message))
  console.log('[companion] Discord bot connecting...')
}

process.on('SIGINT', () => process.exit(0))
process.on('uncaughtException', (err) => console.error('[companion] uncaught:', err.message))
process.on('unhandledRejection', (err) => console.error('[companion] unhandled rejection:', err?.message ?? err))
