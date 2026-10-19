// Test double for the Anthropic Messages API and the OpenRouter API.
// Records every request so tests can assert on model, effort and tools.
import http from 'node:http'

const PORT = Number(process.env.PORT ?? 8080)
// Fixed usage so tests can compute the expected cost exactly
const INPUT_TOKENS = Number(process.env.MOCK_INPUT_TOKENS ?? 1000)
const OUTPUT_TOKENS = Number(process.env.MOCK_OUTPUT_TOKENS ?? 500)
const REPLY = process.env.MOCK_REPLY ?? 'Hallo vom Test-Claude.'

const requests = []

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

function anthropicMessage(model) {
  return {
    id: `msg_mock_${requests.length}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: REPLY }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS },
  }
}

function streamAnthropic(res, model) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const message = anthropicMessage(model)
  send('message_start', {
    type: 'message_start',
    message: { ...message, content: [], stop_reason: null, usage: { input_tokens: INPUT_TOKENS, output_tokens: 1 } },
  })
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  for (const word of REPLY.split(/(?<= )/)) {
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

  // Anthropic Messages API (SDK may call /messages or /v1/messages depending on base URL)
  if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
    const model = body?.model ?? 'unknown'
    return body?.stream ? streamAnthropic(res, model) : sendJson(res, 200, anthropicMessage(model))
  }
  if (req.method === 'POST' && url.pathname.endsWith('/messages/count_tokens')) {
    return sendJson(res, 200, { input_tokens: INPUT_TOKENS })
  }

  return sendJson(res, 404, { error: { type: 'not_found', message: `mock: no route ${req.method} ${url.pathname}` } })
})

server.listen(PORT, () => console.log(`mock listening on ${PORT}`))
