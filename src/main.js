import dotenv from 'dotenv'
import path from 'node:path'
dotenv.config({ path: path.join(path.dirname(process.execPath), '.env') })
dotenv.config()
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { createClient, joinDiscordVoice, leaveVoice } from './bot/client.js'
import { initVoicePlayer, pushAudioFrame, stopAudio } from './bot/voice.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TARGET_URL = process.env.TARGET_URL || 'https://example.com'
const CDP_PORT = process.env.CDP_PORT || '9229'
const SWARM_TOPIC = process.env.SWARM_TOPIC || ''
const SWARM_ROLE = process.env.SWARM_ROLE || 'host'
const CDP_PROXY_PORT = parseInt(process.env.CDP_PROXY_PORT || '9230', 10)
const WS_AUDIO_PORT = parseInt(process.env.WS_AUDIO_PORT || '9888', 10)
const WINDOW_TITLE = 'Discord Voice Bridge'
const VDO_ROOM = process.env.VDO_NINJA_ROOM || ''
const VDO_ID = process.env.VDO_NINJA_STREAM_ID || Math.random().toString(36).slice(2, 8)

for (const [k, v] of [['remote-debugging-port', CDP_PORT], ['remote-debugging-address', '127.0.0.1'],
  ['disable-blink-features', 'AutomationControlled'], ['disable-features', 'MediaRouter'],
  ['autoplay-policy', 'no-user-gesture-required']]) app.commandLine.appendSwitch(k, v)

let mainWindow = null, botClient = null, swarmMod = null, hostMod = null
for (const e of ['unhandledRejection', 'uncaughtException']) process.on(e, (err) => console.error(`[${e}]`, err))
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
const CHROME_VERSION = '134'

function createWindow() {
  session.defaultSession.setUserAgent(CHROME_UA)
  const mainSession = session.fromPartition('persist:main')
  mainSession.setPermissionRequestHandler((_, __, cb) => cb(true))
  mainSession.setPermissionCheckHandler(() => true)
  mainSession.webRequest.onHeadersReceived((details, cb) => {
    const h = details.responseHeaders
    if (!h) { cb({}); return }
    delete h['content-security-policy']; delete h['Content-Security-Policy']
    cb({ responseHeaders: h })
  })
  mainSession.setUserAgent(CHROME_UA)
  mainSession.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders
    h['User-Agent'] = CHROME_UA
    h['sec-ch-ua'] = `"Chromium";v="${CHROME_VERSION}", "Google Chrome";v="${CHROME_VERSION}", "Not:A-Brand";v="99"`
    h['sec-ch-ua-mobile'] = '?0'; h['sec-ch-ua-platform'] = '"Windows"'
    h['Accept-Language'] = 'en-US,en;q=0.9'
    if (!h['Accept']) h['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
    if (!h['Accept-Encoding']) h['Accept-Encoding'] = 'gzip, deflate, br, zstd'
    if (!h['Sec-Fetch-Site']) h['Sec-Fetch-Site'] = 'none'
    if (!h['Sec-Fetch-Mode']) h['Sec-Fetch-Mode'] = 'navigate'
    if (!h['Sec-Fetch-Dest']) h['Sec-Fetch-Dest'] = 'document'
    if (!h['Sec-Fetch-User']) h['Sec-Fetch-User'] = '?1'
    if (details.resourceType === 'mainFrame') { h['Upgrade-Insecure-Requests'] = '1'; h['Priority'] = 'u=0, i' }
    delete h['X-Powered-By']; cb({ requestHeaders: h })
  })

  const preloadDir = (app.isPackaged ? process.resourcesPath : path.join(__dirname, 'electron')).replace(/\\/g, '/')
  mainWindow = new BrowserWindow({
    width: 1280, height: 720, show: true, title: WINDOW_TITLE,
    webPreferences: {
      preload: path.join(__dirname, 'electron', 'preload.cjs'),
      additionalArguments: ['--preload-dir=' + preloadDir],
      contextIsolation: false, autoplayPolicy: 'no-user-gesture-required',
      webSecurity: false, allowRunningInsecureContent: true,
      experimentalFeatures: true, partition: 'persist:main',
    },
  })
  mainWindow.show(); mainWindow.focus()

  if (SWARM_TOPIC && SWARM_ROLE === 'client') {
    mainWindow.loadFile(path.join(__dirname, 'electron', 'remote-view.html')).catch(() => {})
  } else {
    mainWindow.loadURL(TARGET_URL).catch(() => {
      mainWindow.loadFile(path.join(__dirname, 'electron', 'error.html')).catch(() => {})
    })
  }

  mainWindow.webContents.setAudioMuted(true)
  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.insertCSS('html { margin-top: 36px !important; } body { margin-top: 0 !important; }')
    mainWindow.webContents.send('start-capture')
    if (SWARM_TOPIC && SWARM_ROLE === 'host' && hostMod) hostMod.startScreenCapture()
  })
  mainWindow.webContents.on('console-message', (_, level, msg) => { if (level >= 2) console.error('[renderer]', msg) })
  mainWindow.on('closed', () => { mainWindow = null; if (hostMod) hostMod.stopScreenCapture() })
}

const mw = () => mainWindow && !mainWindow.isDestroyed()
for (const [ch, fn] of [['log', (_, m) => console.log('[renderer]', m)], ['nav-back', () => { if (mw()) mainWindow.webContents.goBack() }],
  ['nav-forward', () => { if (mw()) mainWindow.webContents.goForward() }],
  ['nav-go', (_, u) => { if (mw()) mainWindow.webContents.loadURL(u).catch(e => console.error('[nav]', e.message)) }]]) ipcMain.on(ch, fn)

let _audioFrameCount = 0
ipcMain.on('audio-pcm', (_, arrayBuffer) => {
  const buf = Buffer.isBuffer(arrayBuffer) ? arrayBuffer : Buffer.from(arrayBuffer)
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  if (++_audioFrameCount <= 5 || _audioFrameCount % 500 === 0)
    console.log(`[main] audio-pcm #${_audioFrameCount} samples=${f32.length}`)
  pushAudioFrame(f32)
  if (swarmMod && SWARM_ROLE === 'host') swarmMod.sendAudio(f32)
})

async function startP2P() {
  if (!SWARM_TOPIC) return
  ;[swarmMod, hostMod] = await Promise.all([import('./p2p/swarm.js'), import('./p2p/host.js')])
  const cdp = await import('./p2p/cdp-proxy.js')
  await swarmMod.startSwarm(SWARM_TOPIC, SWARM_ROLE, {
    onAudio: (f32) => { if (SWARM_ROLE === 'client') pushAudioFrame(f32) },
    onFrame: (buf) => { if (SWARM_ROLE === 'client' && mw()) mainWindow.webContents.send('screen-frame', buf.toString('base64')) },
    onCdpUp: (buf, conn) => cdp.onSwarmCdpUp(buf, conn),
    onCdpDown: (buf) => cdp.onSwarmCdpDown(buf),
    onInput: (evt) => { if (SWARM_ROLE === 'host' && mw()) try { mainWindow.webContents.sendInputEvent(evt) } catch {} },
    onConnect: (conn) => { console.log('[p2p] +peer'); if (SWARM_ROLE === 'host') cdp.onPeerConnect(conn) },
    onDisconnect: (conn) => { console.log('[p2p] -peer'); if (SWARM_ROLE === 'host') cdp.onPeerDisconnect(conn) },
  })
  cdp.startCdpProxy(SWARM_ROLE, parseInt(CDP_PORT, 10), CDP_PROXY_PORT)
  console.log(`[p2p] started as ${SWARM_ROLE}`)
}

function startWsServer() {
  const MSG_AUDIO = 1
  const wss = new WebSocketServer({ port: WS_AUDIO_PORT, host: '127.0.0.1' })
  wss.on('connection', (ws) => {
    let recvBuf = Buffer.alloc(0)
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
      recvBuf = Buffer.concat([recvBuf, chunk])
      while (recvBuf.length >= 8) {
        const type = recvBuf.readUInt32LE(0)
        const len = recvBuf.readUInt32LE(4)
        if (recvBuf.length < 8 + len) break
        const payload = recvBuf.slice(8, 8 + len)
        recvBuf = recvBuf.slice(8 + len)
        if (type === MSG_AUDIO) {
          const f32 = new Float32Array(payload.buffer, payload.byteOffset, payload.byteLength / 4)
          pushAudioFrame(f32)
          if (swarmMod && SWARM_ROLE === 'host') swarmMod.sendAudio(f32)
        }
      }
    })
    ws.on('error', () => {})
  })
  wss.on('error', (err) => console.error('[ws-audio] error:', err.message))
  console.log(`[ws-audio] listening on ws://127.0.0.1:${WS_AUDIO_PORT}`)
}

async function startBot() {
  const { DISCORD_BOT_TOKEN: tok, GUILD_ID: gid, CHANNEL_ID: cid } = process.env
  if (!tok || !gid || !cid) { console.warn('[bot] missing token/guild/channel — disabled'); return }
  botClient = createClient()
  let _connecting = false
  const connectVoice = async () => {
    if (_connecting) return; _connecting = true
    try {
      const { voiceConnection } = await joinDiscordVoice(botClient, gid, cid)
      initVoicePlayer(voiceConnection); console.log('[bot] joined voice')
      voiceConnection.once('stateChange', (o, n) => {
        if (n.status === 'destroyed') { _connecting = false; setTimeout(connectVoice, 15000) }
      })
    } catch (err) {
      console.error('[bot] Join error:', err.message, '— retrying in 15s')
      _connecting = false; setTimeout(connectVoice, 15000)
    }
  }
  botClient.on('ready', async () => { console.log(`[bot] ${botClient.user.tag}`); await connectVoice() })
  botClient.on('error', (err) => console.error('[bot] error:', err.message))
  botClient.login(tok).catch((e) => console.error('[bot] login failed:', e.message))
}

function startVdoNinja() {
  if (!VDO_ROOM || !/^[a-zA-Z0-9_-]{1,40}$/.test(VDO_ROOM)) { if (VDO_ROOM) console.error('[vdo] invalid room:', VDO_ROOM); return }
  if (!/^[a-zA-Z0-9]{1,20}$/.test(VDO_ID)) { console.error('[vdo] invalid stream id:', VDO_ID); return }
  const s = session.fromPartition('persist:vdo')
  s.setPermissionRequestHandler((_, __, cb) => cb(true)); s.setPermissionCheckHandler(() => true)
  const w = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(__dirname, 'electron', 'vdo-bridge.cjs'),
    contextIsolation: false, webSecurity: false, allowRunningInsecureContent: true,
    autoplayPolicy: 'no-user-gesture-required', partition: 'persist:vdo',
  } })
  const url = `https://vdo.ninja/?push=${encodeURIComponent(VDO_ID)}&room=${encodeURIComponent(VDO_ROOM)}&autostart=1&webcam&label=jerryrig`
  w.loadURL(url).catch((e) => console.error('[vdo] loadURL failed:', e.message))
  const wc = w.webContents
  for (const [ev, fn] of [['console-message', (_, l, m) => { if (l >= 2) console.error('[vdo]', m) }],
    ['render-process-gone', (_, d) => console.error('[vdo] crash:', d.reason)],
    ['unresponsive', () => console.warn('[vdo] unresponsive')],
    ['did-fail-load', (_, c, d) => console.error('[vdo] load failed:', c, d)]]) wc.on(ev, fn)
  console.log(`[vdo] room=${VDO_ROOM} stream=${VDO_ID} | view: https://vdo.ninja/?view=${VDO_ID}&room=${VDO_ROOM}`)
}

app.on('ready', async () => {
  session.defaultSession.setPermissionRequestHandler((_, p, cb) => cb(['media', 'display-capture'].includes(p)))
  createWindow()
  startWsServer()
  startVdoNinja()
  await startP2P()
  await startBot()
})

app.on('before-quit', () => { leaveVoice(); stopAudio(); if (hostMod) hostMod.stopScreenCapture(); if (swarmMod) swarmMod.destroySwarm() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() }); app.on('activate', () => { if (!mainWindow) createWindow() })
