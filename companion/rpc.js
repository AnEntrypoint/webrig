import { WebSocketServer } from 'ws'
import { execSync, exec, spawn } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { resolve, dirname, isAbsolute } from 'node:path'
import * as acp from './acp.js'

const PORT = parseInt(process.env.RPC_PORT ?? '9377')
const CWD = process.env.CWD || process.cwd()

const wss = new WebSocketServer({ port: PORT })

wss.on('connection', ws => {
  const acpUnsubs = new Map()
  ws.on('message', async raw => {
    let msg
    try { msg = JSON.parse(raw) } catch { ws.send(JSON.stringify({ id: null, error: 'invalid json' })); return }
    const { id, method, params } = msg
    try {
      const result = await handle(method, params || {}, ws, acpUnsubs)
      ws.send(JSON.stringify({ id, result }))
    } catch (e) { ws.send(JSON.stringify({ id, error: e.message })) }
  })
  ws.on('close', () => { acpUnsubs.forEach(u => u()); acpUnsubs.clear() })
  ws.on('error', () => {})
})

function resolvePath(p) { return isAbsolute(p) ? p : resolve(CWD, p) }

function shellExec(cmd, cwd) {
  return new Promise(r => exec(cmd, { cwd: cwd || CWD, timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
    (err, stdout, stderr) => r({ exitCode: err ? (err.code || 1) : 0, stdout, stderr })))
}

async function handle(method, params, ws, acpUnsubs) {
  switch (method) {
    case 'ping': return { ok: true, cwd: CWD, version: '1.0.0', agents: Object.keys(acp.AGENTS) }
    case 'shell.exec': {
      if (!params.command) throw new Error('command required')
      return shellExec(params.command, params.cwd)
    }
    case 'fs.read': return { content: readFileSync(resolvePath(params.path), 'utf-8') }
    case 'fs.write': {
      const p = resolvePath(params.path); mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, params.content, 'utf-8'); return { written: params.content.length }
    }
    case 'fs.list': return readdirSync(resolvePath(params.path || '.'), { withFileTypes: true })
      .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }))
    case 'fs.exists': return { exists: existsSync(resolvePath(params.path)) }
    case 'fs.delete': { rmSync(resolvePath(params.path), { recursive: true, force: true }); return { deleted: true } }
    case 'fs.stat': { const s = statSync(resolvePath(params.path)); return { size: s.size, isDir: s.isDirectory(), modified: s.mtime.toISOString() } }
    case 'git.status': return shellExec('git status --porcelain', params.cwd)
    case 'git.log': return shellExec('git log --oneline -20', params.cwd)
    case 'git.diff': return shellExec('git diff', params.cwd)
    case 'acp.agents': return { agents: Object.keys(acp.AGENTS) }
    case 'acp.sessions.new': {
      const info = await acp.createSession(params.agent || 'claude', params.cwd || CWD, params.name)
      const unsub = acp.subscribe(info.id, evt => {
        try { ws.send(JSON.stringify({ stream: true, sessionId: info.id, event: evt })) } catch {}
      })
      acpUnsubs.set(info.id, unsub); return info
    }
    case 'acp.sessions.list': return acp.listSessions()
    case 'acp.sessions.close': return acp.closeSession(params.sessionId)
    case 'acp.prompt': {
      if (!params.sessionId || !params.text) throw new Error('sessionId and text required')
      return acp.prompt(params.sessionId, params.text)
    }
    case 'acp.cancel': return acp.cancel(params.sessionId)
    case 'acp.status': {
      const s = acp.getSession(params.sessionId)
      return s ? { id: s.id, status: s.status, pid: s.pid, agent: s.agent, historyLength: s.history.length } : { status: 'not_found' }
    }
    default: throw new Error('unknown method: ' + method)
  }
}

console.log('[rpc] webrig companion rpc on ws://127.0.0.1:' + PORT)
console.log('[rpc] agents:', Object.keys(acp.AGENTS).join(', '))
