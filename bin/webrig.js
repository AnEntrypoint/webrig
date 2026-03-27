#!/usr/bin/env node
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer as netServer } from 'node:net'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', 'shell')
const SHELL_PORT = parseInt(process.env.SHELL_PORT ?? '7070')
const RPC_PORT = parseInt(process.env.RPC_PORT ?? '9377')
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT ?? '9233')

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' }

function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const s = netServer()
    s.listen(start, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
    s.on('error', () => findFreePort(start + 1).then(resolve, reject))
  })
}

function openUrl(url) {
  const p = os.platform()
  const [cmd, args] = p === 'win32' ? ['cmd', ['/c','start','',url]] : p === 'darwin' ? ['open',[url]] : ['xdg-open',[url]]
  spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false }).unref()
}

function startChild(script, env = {}) {
  const child = spawn(process.execPath, ['--input-type=module'], {
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, ...env }
  })
  child.stdin.write(`import '${script}'
`)
  child.stdin.end()
  child.on('error', e => console.error('[webrig]', script, e.message))
  return child
}

const rpcScript = join(__dirname, '..', 'companion', 'rpc.js')
const bridgeScript = join(__dirname, '..', 'companion', 'bridge.js')

const children = [
  startChild(rpcScript, { RPC_PORT: String(RPC_PORT) }),
  startChild(bridgeScript, { BRIDGE_PORT: String(BRIDGE_PORT) }),
]

const port = await findFreePort(SHELL_PORT)
const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(); return }
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0]
  const filePath = join(ROOT, urlPath)
  const mime = MIME[extname(filePath)] || 'text/plain'
  try {
    const data = readFileSync(filePath)
    res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' })
    res.end(data)
  } catch { res.writeHead(404); res.end('not found') }
})

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}`
  console.log('[webrig] shell at', url)
  console.log('[webrig] rpc on', RPC_PORT, '| bridge on', BRIDGE_PORT)
  setTimeout(() => openUrl(url), 1200)
})

process.on('SIGINT', () => { children.forEach(c => c.kill()); process.exit(0) })
process.on('SIGTERM', () => { children.forEach(c => c.kill()); process.exit(0) })
