import { WebContainer } from 'https://esm.sh/@webcontainer/api'

const AGENTS = {
  claude:   ['npx', ['-y','@anthropic-ai/claude-code','--dangerously-skip-permissions']],
  kilo:     ['npx', ['-y','@kilocode/cli','kilo']],
  opencode: ['npx', ['-y','opencode-ai']],
}

let wc = null
let _status = 'unavailable'
const cbs = new Set()

function setStatus(s) { _status = s; cbs.forEach(fn => fn(s)) }

export function wcStatus() { return _status }
export function onWcStatus(fn) { cbs.add(fn); fn(_status); return () => cbs.delete(fn) }

export async function boot() {
  if (!(typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated)) { setStatus('unavailable'); return }
  if (wc) return
  setStatus('booting')
  try { wc = await WebContainer.boot(); setStatus('ready') }
  catch(e) { setStatus('unavailable') }
}

export async function runCli(agent, prompt, onLine) {
  const cfg = AGENTS[agent]
  if (!cfg) { onLine({ type: 'err', text: 'unknown agent: ' + agent }); return }
  if (_status !== 'ready') { onLine({ type: 'err', text: 'WebContainer ' + _status }); return }
  try {
    const proc = await wc.spawn(cfg[0], [...cfg[1], prompt], {
      env: { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin' }
    })
    proc.output.pipeTo(new WritableStream({ write(data) { onLine({ type: 'out', text: data }) } }))
    const code = await proc.exit
    onLine({ type: 'info', text: '[exited ' + code + ']' })
  } catch(e) { onLine({ type: 'err', text: e.message }) }
}
