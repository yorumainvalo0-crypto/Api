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

/** A scripted model turn: plain text, or a tool call (optionally preceded by text). */
export interface MockTurn {
  text?: string
  toolUse?: { name: string; input: Record<string, unknown> }
}

export type MockReply = string | MockTurn | ((body: unknown) => string | MockTurn)

/**
 * Minimal Anthropic Messages API mock (the same surface OpenRouter and Ollama expose).
 * Every /v1/messages call answers with `reply` (or its result for the request body),
 * streamed or not. Turns with `toolUse` end with stop_reason "tool_use" like a real model.
 */
export async function startMockAnthropic(reply: MockReply): Promise<MockAnthropic> {
  const requests: RecordedRequest[] = []
  let toolCounter = 0

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

      // A page whose content only exists after client-side JavaScript ran.
      if (req.method === 'GET' && path === '/js-page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          '<html><head><title>JS-Seite</title></head><body><div id="out"></div>' +
            '<script>document.getElementById("out").textContent = "Von JavaScript gerendert"</script>' +
            '</body></html>',
        )
        return
      }
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ input_tokens: 10 }))
        return
      }
      if (req.method === 'POST' && path === '/v1/messages') {
        const model = (body as { model?: string } | undefined)?.model ?? 'mock-model'
        const stream = (body as { stream?: boolean } | undefined)?.stream === true
        const resolved = typeof reply === 'function' ? reply(body) : reply
        const turn: MockTurn = typeof resolved === 'string' ? { text: resolved } : resolved
        const toolUse = turn.toolUse
          ? {
              type: 'tool_use',
              id: `toolu_mock_${++toolCounter}`,
              name: turn.toolUse.name,
              input: turn.toolUse.input,
            }
          : undefined
        const content: Record<string, unknown>[] = [
          ...(turn.text !== undefined ? [{ type: 'text', text: turn.text }] : []),
          ...(toolUse ? [toolUse] : []),
        ]
        const stopReason = toolUse ? 'tool_use' : 'end_turn'
        const message = {
          id: `msg_${requests.length}`,
          type: 'message',
          role: 'assistant',
          model,
          content,
          stop_reason: stopReason,
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
        content.forEach((block, index) => {
          if (block['type'] === 'text') {
            const text = String(block['text'])
            send('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: { type: 'text', text: '' },
            })
            // Split into two deltas to exercise streaming.
            const mid = Math.ceil(text.length / 2)
            for (const part of [text.slice(0, mid), text.slice(mid)]) {
              send('content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'text_delta', text: part },
              })
            }
          } else {
            send('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: { ...block, input: {} },
            })
            send('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(block['input']) },
            })
          }
          send('content_block_stop', { type: 'content_block_stop', index })
        })
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
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
