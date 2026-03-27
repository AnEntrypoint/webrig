const MAX_LOOPS = 50

export const TOOL_DEFS = [
  {
    name: 'cdp',
    description: 'Execute a Chrome DevTools Protocol command on the active browser tab via the extension',
    input_schema: { type: 'object', properties: { method: { type: 'string', description: 'CDP method e.g. Page.navigate' }, params: { type: 'object', description: 'CDP params' } }, required: ['method'] }
  },
  {
    name: 'shell',
    description: 'Execute a shell command on the local machine via the companion server',
    input_schema: { type: 'object', properties: { cmd: { type: 'string' }, cwd: { type: 'string' } }, required: ['cmd'] }
  },
  {
    name: 'fs_read',
    description: 'Read a file from the local filesystem via the companion server',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'fs_write',
    description: 'Write content to a file via the companion server',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
  }
]

export class AgentRunner {
  constructor({ baseUrl, apiKey, model, cdp, companion, onEvent }) {
    this._baseUrl = baseUrl || 'http://127.0.0.1:9233'
    this._apiKey = apiKey || ''
    this._model = model || 'claude-opus-4-6'
    this._cdp = cdp || null
    this._companion = companion || null
    this._onEvent = onEvent || (() => {})
    this._aborted = false
  }

  abort() { this._aborted = true }

  async run(prompt, extraTools = []) {
    const tools = [...TOOL_DEFS, ...extraTools]
    const messages = [{ role: 'user', content: prompt }]
    let loops = 0
    this._aborted = false

    while (loops++ < MAX_LOOPS && !this._aborted) {
      const body = { model: this._model, max_tokens: 8192, messages, tools, ...(this._apiKey ? { _apiKey: this._apiKey } : {}) }
      const resp = await fetch(this._baseUrl + '/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!resp.ok) throw new Error('API error: ' + resp.status + ' ' + await resp.text())
      const msg = await resp.json()
      if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error))

      this._onEvent({ type: 'message', message: msg })
      messages.push({ role: 'assistant', content: msg.content })

      const toolUses = msg.content.filter(b => b.type === 'tool_use')
      if (!toolUses.length || msg.stop_reason === 'end_turn') break

      const results = await Promise.all(toolUses.map(tu => this._executeTool(tu)))
      messages.push({ role: 'user', content: toolUses.map((tu, i) => ({ type: 'tool_result', tool_use_id: tu.id, content: results[i] })) })
    }

    return messages
  }

  async runStream(prompt, extraTools = [], onDelta) {
    const tools = [...TOOL_DEFS, ...extraTools]
    const messages = [{ role: 'user', content: prompt }]
    let loops = 0
    this._aborted = false

    while (loops++ < MAX_LOOPS && !this._aborted) {
      const body = { model: this._model, max_tokens: 8192, messages, tools, stream: true, ...(this._apiKey ? { _apiKey: this._apiKey } : {}) }
      const resp = await fetch(this._baseUrl + '/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!resp.ok) throw new Error('API error: ' + resp.status)

      const { content, stopReason } = await this._consumeStream(resp.body, onDelta)
      messages.push({ role: 'assistant', content })

      const toolUses = content.filter(b => b.type === 'tool_use')
      if (!toolUses.length || stopReason === 'end_turn') break

      const results = await Promise.all(toolUses.map(tu => this._executeTool(tu)))
      messages.push({ role: 'user', content: toolUses.map((tu, i) => ({ type: 'tool_result', tool_use_id: tu.id, content: results[i] })) })
    }

    return messages
  }

  async _consumeStream(body, onDelta) {
    const content = []
    let stopReason = 'end_turn'
    const decoder = new TextDecoder()
    let buf = ''
    const currentBlocks = new Map()

    for await (const chunk of body) {
      buf += decoder.decode(chunk, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') continue
        try {
          const evt = JSON.parse(data)
          if (evt.type === 'content_block_start' && evt.content_block) {
            currentBlocks.set(evt.index, { ...evt.content_block })
            if (evt.content_block.type === 'tool_use') currentBlocks.get(evt.index)._args = ''
          } else if (evt.type === 'content_block_delta') {
            const blk = currentBlocks.get(evt.index)
            if (!blk) continue
            if (evt.delta.type === 'text_delta') { blk.text = (blk.text || '') + evt.delta.text; onDelta?.({ type: 'text', text: evt.delta.text }) }
            else if (evt.delta.type === 'input_json_delta') blk._args = (blk._args || '') + evt.delta.partial_json
          } else if (evt.type === 'content_block_stop') {
            const blk = currentBlocks.get(evt.index)
            if (blk) {
              if (blk._args !== undefined) { try { blk.input = JSON.parse(blk._args) } catch { blk.input = {} }; delete blk._args }
              content.push(blk)
            }
          } else if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
            stopReason = evt.delta.stop_reason
          }
        } catch {}
      }
    }

    return { content, stopReason }
  }

  async _executeTool(tu) {
    this._onEvent({ type: 'tool_call', name: tu.name, input: tu.input })
    try {
      let result
      if (tu.name === 'cdp') {
        if (!this._cdp) return JSON.stringify({ error: 'CDP not connected' })
        result = await this._cdp.send(tu.input.method, tu.input.params || {})
      } else if (tu.name === 'shell') {
        if (!this._companion) return JSON.stringify({ error: 'companion not connected' })
        result = await this._companion.call('shell_exec', tu.input)
      } else if (tu.name === 'fs_read') {
        if (!this._companion) return JSON.stringify({ error: 'companion not connected' })
        result = await this._companion.call('fs_read', tu.input)
      } else if (tu.name === 'fs_write') {
        if (!this._companion) return JSON.stringify({ error: 'companion not connected' })
        result = await this._companion.call('fs_write', tu.input)
      } else {
        return JSON.stringify({ error: 'unknown tool: ' + tu.name })
      }
      this._onEvent({ type: 'tool_result', name: tu.name, result })
      return typeof result === 'string' ? result : JSON.stringify(result)
    } catch (e) {
      this._onEvent({ type: 'tool_error', name: tu.name, error: e.message })
      return JSON.stringify({ error: e.message })
    }
  }
}

export function createAgent(opts) { return new AgentRunner(opts) }
