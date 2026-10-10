import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: unknown
}

export interface MockAnthropic {
  url: string
  requests: RecordedRequest[]
  close: () => Promise<void>
}

/**
 * Minimal Anthropic Messages API mock (the same surface OpenRouter and Ollama expose).
 * Every /v1/messages call answers with `reply` (or its result for the request body), streamed or not.
 */
export async function startMockAnthropic(
  reply: string | ((body: unknown) => string),
): Promise<MockAnthropic> {
  const requests: RecordedRequest[] = []

  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      let body: unknown
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        body = raw
      }
      const path = (req.url ?? '').split('?')[0] ?? ''
      requests.push({ method: req.method ?? '', path, headers: req.headers, body })

      if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ input_tokens: 10 }))
        return
      }
      if (req.method === 'POST' && path === '/v1/messages') {
        const model = (body as { model?: string } | undefined)?.model ?? 'mock-model'
        const stream = (body as { stream?: boolean } | undefined)?.stream === true
        const replyText = typeof reply === 'string' ? reply : reply(body)
        const message = {
          id: `msg_${requests.length}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: replyText }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }
        if (!stream) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(message))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const send = (event: string, data: unknown) =>
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        send('message_start', {
          type: 'message_start',
          message: {
            ...message,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        })
        send('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })
        // Split into two deltas to exercise streaming.
        const mid = Math.ceil(replyText.length / 2)
        for (const part of [replyText.slice(0, mid), replyText.slice(mid)]) {
          send('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: part },
          })
        }
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 5 },
        })
        send('message_stop', { type: 'message_stop' })
        res.end()
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: path } }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
