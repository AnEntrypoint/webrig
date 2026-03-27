const CACHE = 'bridge-sw-v1'
const BRIDGE_CONFIG_KEY = 'bridge_config'

let config = { anthropicApiKey: '', openaiApiKey: '', openrouterApiKey: '' }

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('message', (e) => {
  if (e.data?.type === 'BRIDGE_CONFIG') config = { ...config, ...e.data.config }
  if (e.data?.type === 'GET_CONFIG') e.source?.postMessage({ type: 'BRIDGE_CONFIG_REPLY', config })
})

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
  const sys = body.system ? [{ role: 'system', content: body.system }] : []
  const tools = (body.tools || []).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
  return { model, messages: [...sys, ...messages], max_tokens: body.max_tokens, stream: body.stream || false, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }
}

function openaiToAnthropic(data) {
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

function openaiChunkToSSE(chunk, toolIdx) {
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

async function handleMessages(req) {
  const body = await req.json()
  const { type } = getProvider(body.model)
  const streaming = body.stream === true

  if (type === 'anthropic') {
    const apiKey = body._apiKey || config.anthropicApiKey
    const cleanBody = { ...body }; delete cleanBody._apiKey
    const resp = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ ...cleanBody, stream: streaming }) })
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': streaming ? 'text/event-stream' : 'application/json', 'Access-Control-Allow-Origin': '*' } })
  }

  const isOpenRouter = type === 'openrouter'
  const { model } = getProvider(body.model)
  const converted = anthropicToOpenAI(body, model)
  converted.stream = streaming
  const apiKey = body._apiKey || (isOpenRouter ? config.openrouterApiKey : config.openaiApiKey)
  const baseUrl = isOpenRouter ? 'https://openrouter.ai/api' : 'https://api.openai.com'
  const resp = await fetch(baseUrl + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey }, body: JSON.stringify(converted) })

  if (!streaming) {
    const data = await resp.json()
    return new Response(JSON.stringify(openaiToAnthropic(data)), { status: resp.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } })
  }

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  ;(async () => {
    writer.write(encoder.encode('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 0, output_tokens: 0 } } }) + '\n\n'))
    writer.write(encoder.encode('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + '\n\n'))
    let toolIdx = 1; const decoder = new TextDecoder(); let buf = ''
    for await (const chunk of resp.body) {
      buf += decoder.decode(chunk, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
        try { const parsed = JSON.parse(line.slice(6)); for (const s of openaiChunkToSSE(parsed, toolIdx)) writer.write(encoder.encode(s)) } catch {}
      }
    }
    writer.write(encoder.encode('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n'))
    writer.close()
  })().catch(() => writer.abort())
  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' } })
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.pathname === '/v1/messages') {
    if (e.request.method === 'OPTIONS') { e.respondWith(new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } })); return }
    if (e.request.method === 'POST') { e.respondWith(handleMessages(e.request).catch(err => new Response(JSON.stringify({ error: { type: 'api_error', message: err.message } }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }))); return }
  }
})
