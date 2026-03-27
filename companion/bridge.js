import { createServer } from 'node:http'

const PORT = parseInt(process.env.BRIDGE_PORT ?? '9233')
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY

function getProvider(model) {
  if (model.startsWith('openai/')) return { type: 'openai', model: model.slice(7) }
  if (model.startsWith('openrouter/')) return { type: 'openrouter', model: model.slice(11) }
  return { type: 'anthropic', model }
}

function anthropicToOpenAI(body, model) {
  const messages = []
  for (const m of (body.messages || [])) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue }
    const toolResults = m.content.filter(b => b.type === 'tool_result')
    if (toolResults.length) {
      for (const tr of toolResults)
        messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content) })
      continue
    }
    const toolUses = m.content.filter(b => b.type === 'tool_use')
    if (toolUses.length && m.role === 'assistant') {
      const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('')
      messages.push({ role: 'assistant', content: text || null, tool_calls: toolUses.map(tu => ({ id: tu.id, type: 'function', function: { name: tu.name, arguments: JSON.stringify(tu.input) } })) })
      continue
    }
    messages.push({ role: m.role, content: m.content.filter(b => b.type === 'text').map(b => b.text).join('') })
  }
  const tools = (body.tools || []).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
  return { model, messages, max_tokens: body.max_tokens, stream: body.stream || false, ...(body.system ? { messages: [{ role: 'system', content: body.system }, ...messages] } : {}), ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }
}

function openaiResponseToAnthropic(data) {
  const choice = data.choices?.[0]
  if (!choice) return { type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }
  const content = []
  if (choice.message.content) content.push({ type: 'text', text: choice.message.content })
  for (const tc of (choice.message.tool_calls || [])) {
    let inp; try { inp = JSON.parse(tc.function.arguments) } catch { inp = {} }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: inp })
  }
  return { type: 'message', id: data.id, role: 'assistant', content, model: data.model, stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn', usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 } }
}

function openaiChunkToAnthropicSSE(chunk, toolIdx) {
  const delta = chunk.choices?.[0]?.delta
  if (!delta) return []
  const lines = []
  if (delta.content) lines.push('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } }) + '\n\n')
  if (delta.tool_calls) {
    const tc = delta.tool_calls[0]
    if (tc.function?.name) lines.push('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: toolIdx, content_block: { type: 'tool_use', id: tc.id || 'tu_' + toolIdx, name: tc.function.name, input: {} } }) + '\n\n')
    if (tc.function?.arguments) lines.push('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: toolIdx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } }) + '\n\n')
  }
  return lines
}

async function proxyAnthropic(body, res, streaming) {
  const apiKey = ANTHROPIC_API_KEY || body._apiKey
  const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  const cleanBody = { ...body }; delete cleanBody._apiKey
  const resp = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify({ ...cleanBody, stream: streaming }) })
  if (streaming) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' })
    for await (const chunk of resp.body) res.write(chunk)
    res.end()
  } else {
    const data = await resp.json()
    res.writeHead(resp.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(data))
  }
}

async function proxyOpenAI(body, res, streaming, baseUrl, apiKey) {
  const { type, model } = getProvider(body.model)
  const converted = anthropicToOpenAI(body, model)
  converted.stream = streaming
  const url = (baseUrl || 'https://api.openai.com') + '/v1/chat/completions'
  const key = apiKey || OPENAI_API_KEY || body._apiKey
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key }, body: JSON.stringify(converted) })
  if (!streaming) {
    const data = await resp.json()
    const anthropicResp = openaiResponseToAnthropic(data)
    res.writeHead(resp.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(anthropicResp))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' })
  res.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 0, output_tokens: 0 } } }) + '\n\n')
  res.write('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + '\n\n')
  let toolIdx = 1; const decoder = new TextDecoder(); let buf = ''
  for await (const chunk of resp.body) {
    buf += decoder.decode(chunk, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
      try { const parsed = JSON.parse(line.slice(6)); for (const s of openaiChunkToAnthropicSSE(parsed, toolIdx)) res.write(s) } catch {}
    }
  }
  res.write('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n')
  res.end()
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); res.end(); return }
  if (req.url === '/health' || req.url === '/') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok' })); return }
  if (req.url !== '/v1/messages') { res.writeHead(404); res.end(); return }
  let body = ''
  req.on('data', d => body += d)
  req.on('end', async () => {
    try {
      const parsed = JSON.parse(body)
      const { type } = getProvider(parsed.model)
      const streaming = parsed.stream === true
      if (type === 'anthropic') await proxyAnthropic(parsed, res, streaming)
      else if (type === 'openrouter') await proxyOpenAI(parsed, res, streaming, 'https://openrouter.ai/api', OPENROUTER_API_KEY)
      else await proxyOpenAI(parsed, res, streaming, null, null)
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: { type: 'api_error', message: e.message } }))
    }
  })
})

server.listen(PORT, '127.0.0.1', () => console.log('[bridge] Anthropic-compatible proxy on', PORT))
export { server }
