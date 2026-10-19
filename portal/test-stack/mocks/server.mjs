// Test double for the Anthropic Messages API and the OpenRouter API.
// Records every request so tests can assert on model, effort and tools.
import http from 'node:http'

const PORT = Number(process.env.PORT ?? 8080)
// Fixed usage so tests can compute the expected cost exactly
const INPUT_TOKENS = Number(process.env.MOCK_INPUT_TOKENS ?? 1000)
const OUTPUT_TOKENS = Number(process.env.MOCK_OUTPUT_TOKENS ?? 500)
const REPLY = process.env.MOCK_REPLY ?? 'Hallo vom Test-Claude.'

const requests = []
// 64x64 teal PNG for generated images
const TEST_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PwQkAIBDAsNvATX06v0P4CEKhA6Szzv664YIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALHru5GzDiczfnBgAAAABJRU5ErkJggg=='
// Scripted tool calls: when a prompt contains `trigger`, answer with a tool_use first,
// then with `reply` once the tool result comes back
const scenarios = []

function lastUserMessage(body) {
  const messages = body?.messages ?? []
  return messages[messages.length - 1]
}

function hasToolResult(message) {
  return Array.isArray(message?.content) && message.content.some((block) => block.type === 'tool_result')
}

/** Scenarios match the latest text the user typed (not tool results, not older turns). */
function findScenario(body) {
  const messages = body?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ')
    if (!text) continue
    return scenarios.find((s) => text.includes(s.trigger))
  }
  return undefined
}

function streamToolUse(res, model, tool, input) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  send('message_start', {
    type: 'message_start',
    message: { id: `msg_tool_${requests.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: INPUT_TOKENS, output_tokens: 1 } },
  })
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_mock_${requests.length}`, name: tool, input: {} } })
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
  send('content_block_stop', { type: 'content_block_stop', index: 0 })
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: OUTPUT_TOKENS } })
  send('message_stop', { type: 'message_stop' })
  res.end()
}

/** Anthropic's server-side web search: search blocks, results and the answer in one message. */
function streamWebSearch(res, model, queries, reply) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  send('message_start', {
    type: 'message_start',
    message: { id: `msg_search_${requests.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: INPUT_TOKENS, output_tokens: 1 } },
  })
  let index = 0
  queries.forEach((query, n) => {
    const id = `srvtoolu_mock_${requests.length}_${n}`
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'server_tool_use', id, name: 'web_search', input: {} } })
    send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) } })
    send('content_block_stop', { type: 'content_block_stop', index })
    index++
    const content = [{ type: 'web_search_result', url: `https://example.org/${n}`, title: `Treffer ${n + 1} zu ${query}`, encrypted_content: 'ZW5jcnlwdGVk', page_age: null }]
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'web_search_tool_result', tool_use_id: id, content } })
    send('content_block_stop', { type: 'content_block_stop', index })
    index++
  })
  send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
  send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: reply } })
  send('content_block_stop', { type: 'content_block_stop', index })
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: OUTPUT_TOKENS, server_tool_use: { web_search_requests: queries.length } },
  })
  send('message_stop', { type: 'message_stop' })
  res.end()
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function anthropicMessage(model, reply = REPLY) {
  return {
    id: `msg_mock_${requests.length}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: reply }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS },
  }
}

function streamAnthropic(res, model, reply = REPLY) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const message = anthropicMessage(model, reply)
  send('message_start', {
    type: 'message_start',
    message: { ...message, content: [], stop_reason: null, usage: { input_tokens: INPUT_TOKENS, output_tokens: 1 } },
  })
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  for (const word of reply.split(/(?<= )/)) {
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } })
  }
  send('content_block_stop', { type: 'content_block_stop', index: 0 })
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: OUTPUT_TOKENS },
  })
  send('message_stop', { type: 'message_stop' })
  res.end()
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://mock')
  const raw = req.method === 'POST' ? await readBody(req) : ''
  let body = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    body = raw
  }

  if (url.pathname === '/__requests') {
    if (req.method === 'DELETE') requests.length = 0
    return sendJson(res, 200, requests)
  }
  if (url.pathname === '/health') return sendJson(res, 200, { ok: true })
  if (url.pathname === '/__scenarios') {
    if (req.method === 'POST') scenarios.push(body)
    if (req.method === 'DELETE') scenarios.length = 0
    return sendJson(res, 200, scenarios)
  }

  // Minimal MCP server (streamable HTTP, JSON responses) standing in for the portal gateway
  if (url.pathname === '/portal/mcp') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (body?.id === undefined) {
      res.writeHead(202)
      return res.end()
    }
    const results = {
      initialize: {
        protocolVersion: body.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'portal-mock', version: '0.0.0' },
      },
      'tools/list': {
        tools: [
          {
            name: 'portal_status',
            description: 'Returns the portal status (test double).',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
      'tools/call': { content: [{ type: 'text', text: 'ok' }] },
      ping: {},
    }
    const result = results[body.method]
    return sendJson(
      res,
      200,
      result
        ? { jsonrpc: '2.0', id: body.id, result }
        : { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } },
    )
  }

  requests.push({ method: req.method, path: url.pathname, headers: req.headers, body, at: Date.now() })

  // OpenRouter media endpoints (images, speech, videos) for the gateway's media tools
  if (url.pathname === '/api/v1/images' && req.method === 'POST') {
    return sendJson(res, 200, { data: [{ b64_json: TEST_PNG, media_type: 'image/png' }], usage: { cost: 0.04 } })
  }
  if (url.pathname === '/api/v1/audio/speech' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'x-generation-id': `gen-${requests.length}` })
    return res.end(Buffer.from('ID3test-mp3'))
  }
  if (url.pathname === '/api/v1/generation') return sendJson(res, 200, { data: { total_cost: 0.002 } })
  if (url.pathname === '/api/v1/videos' && req.method === 'POST') {
    return sendJson(res, 202, { id: `vid-${requests.length}`, status: 'pending' })
  }
  if (/^\/api\/v1\/videos\/[^/]+$/.test(url.pathname)) {
    return sendJson(res, 200, { status: 'completed', usage: { cost: 0.5 } })
  }
  if (/^\/api\/v1\/videos\/[^/]+\/content$/.test(url.pathname)) {
    res.writeHead(200, { 'content-type': 'video/mp4' })
    return res.end(Buffer.from('....ftypmp42test-video'))
  }

  // Anthropic Messages API (SDK may call /messages or /v1/messages depending on base URL)
  if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
    const model = body?.model ?? 'unknown'
    const scenario = body?.stream ? findScenario(body) : null
    if (scenario?.webSearch) return streamWebSearch(res, model, scenario.webSearch, scenario.reply ?? REPLY)
    if (scenario && !hasToolResult(lastUserMessage(body))) {
      return streamToolUse(res, model, scenario.tool, scenario.input)
    }
    return body?.stream ? streamAnthropic(res, model, scenario?.reply) : sendJson(res, 200, anthropicMessage(model))
  }
  if (req.method === 'POST' && url.pathname.endsWith('/messages/count_tokens')) {
    return sendJson(res, 200, { input_tokens: INPUT_TOKENS })
  }

  return sendJson(res, 404, { error: { type: 'not_found', message: `mock: no route ${req.method} ${url.pathname}` } })
})

server.listen(PORT, () => console.log(`mock listening on ${PORT}`))
