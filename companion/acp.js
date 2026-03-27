import { spawn } from 'node:child_process'

const AGENTS = {
  claude: 'npx -y @anthropic-ai/claude-code --dangerously-skip-permissions',
  kilo: 'npx -y @kilocode/cli acp',
  kilocode: 'npx -y @kilocode/cli acp',
  opencode: 'npx -y opencode-ai acp',
  codex: 'npx -y @openai/codex',
}

let ClientSideConnection, Stream
try {
  const sdk = await import('@agentclientprotocol/sdk')
  ClientSideConnection = sdk.ClientSideConnection
  Stream = sdk.Stream
} catch { ClientSideConnection = null; Stream = null }

const sessions = new Map()
let idCounter = 0

function resolveCmd(agent) { return AGENTS[agent] || agent }

export async function createSession(agent, cwd, name) {
  const id = 'acp-' + (++idCounter) + '-' + Date.now().toString(36)
  const cmd = resolveCmd(agent)
  const parts = cmd.split(' ')
  const proc = spawn(parts[0], parts.slice(1), {
    cwd: cwd || process.cwd(), shell: true, stdio: ['pipe','pipe','pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
  })
  const session = {
    id, agent, cwd, name: name || 'default', pid: proc.pid,
    proc, conn: null, acpSessionId: null,
    status: 'starting', createdAt: Date.now(),
    listeners: new Set(), history: [], rpcId: 0, pending: new Map(), buffer: ''
  }
  proc.stderr.on('data', c => { const t = c.toString().trim(); if (t) broadcast(session, { type: 'stderr', text: t }) })
  proc.on('close', code => { session.status = 'closed'; broadcast(session, { type: 'session_closed', code }) })
  proc.on('error', err => { session.status = 'error'; broadcast(session, { type: 'error', message: err.message }) })

  if (ClientSideConnection && Stream) {
    try {
      const stream = Stream.fromReadableWritable(proc.stdout, proc.stdin)
      const conn = new ClientSideConnection((_api) => ({
        sessionUpdate(params) { session.history.push(params); broadcast(session, { type: 'acp_event', data: { method: 'session/update', params } }) },
        permissionRequest(params) { broadcast(session, { type: 'permission_request', data: params }); return { decision: 'allow' } }
      }), stream)
      session.conn = conn
      await conn.initialize({ clientInfo: { name: 'webrig', version: '1.0.0' } })
      const ns = await conn.newSession({})
      session.acpSessionId = ns.sessionId
      session.status = 'running'
    } catch (e) {
      session.status = 'running'
      broadcast(session, { type: 'stderr', text: 'SDK init failed, raw mode: ' + e.message })
      setupRaw(session)
    }
  } else {
    setupRaw(session); session.status = 'running'
  }

  sessions.set(id, session)
  return { id, pid: proc.pid, agent, cwd, name: session.name, acpSessionId: session.acpSessionId }
}

function setupRaw(session) {
  session.proc.stdout.on('data', chunk => {
    session.buffer += chunk.toString()
    const lines = session.buffer.split('\n'); session.buffer = lines.pop() || ''
    for (const line of lines) {
      const t = line.trim(); if (!t) continue
      try { const m = JSON.parse(t); handleRaw(session, m) }
      catch { broadcast(session, { type: 'stderr', text: t }) }
    }
  })
}

function handleRaw(session, msg) {
  if (msg.id && session.pending.has(msg.id)) {
    const { resolve } = session.pending.get(msg.id); session.pending.delete(msg.id); resolve(msg.result || msg); return
  }
  session.history.push(msg); broadcast(session, { type: 'acp_event', data: msg })
}

function broadcast(session, event) { session.listeners.forEach(fn => fn(event)) }

export async function prompt(sessionId, text) {
  const s = sessions.get(sessionId); if (!s) throw new Error('session not found: ' + sessionId)
  if (s.conn && s.acpSessionId) return s.conn.prompt({ sessionId: s.acpSessionId, prompt: text })
  return sendRaw(s, 'session/prompt', { sessionId: s.acpSessionId || 'default', prompt: text })
}

function sendRaw(session, method, params) {
  return new Promise((resolve, reject) => {
    if (!session.proc || session.status !== 'running') return reject(new Error('not running'))
    const id = 'req-' + (++session.rpcId)
    session.pending.set(id, { resolve, reject })
    session.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => { if (session.pending.has(id)) { session.pending.delete(id); reject(new Error('timeout')) } }, 120000)
  })
}

export async function cancel(sessionId) {
  const s = sessions.get(sessionId); if (!s) throw new Error('session not found')
  if (s.conn && s.acpSessionId) { await s.conn.cancel({ sessionId: s.acpSessionId, reason: 'user_cancelled' }); return { cancelled: true } }
  return sendRaw(s, 'session/cancel', {})
}

export async function closeSession(sessionId) {
  const s = sessions.get(sessionId); if (!s) throw new Error('session not found')
  if (s.conn) { try { await s.conn.unstable_closeSession({ sessionId: s.acpSessionId }) } catch {} }
  if (s.proc && s.status === 'running') s.proc.kill()
  sessions.delete(sessionId); return { closed: true }
}

export function listSessions() {
  return [...sessions.values()].map(s => ({ id: s.id, agent: s.agent, cwd: s.cwd, name: s.name, status: s.status, pid: s.pid, createdAt: s.createdAt, acpSessionId: s.acpSessionId, historyLength: s.history.length }))
}

export function getSession(id) { return sessions.get(id) || null }

export function subscribe(sessionId, fn) {
  const s = sessions.get(sessionId); if (!s) return () => {}
  s.listeners.add(fn); return () => s.listeners.delete(fn)
}

export { AGENTS }
