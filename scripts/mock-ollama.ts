import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface MockOllama {
  url: string
  installed: Set<string>
  /** Bodies received on /api/chat. */
  chats: {
    model: string
    keep_alive?: string
    messages: { content: string; images?: string[] }[]
  }[]
  close: () => Promise<void>
}

/** Minimal Ollama API mock for the OCR feature: version, tags, pull (NDJSON), delete, chat. */
export async function startMockOllama(
  transcription = 'Liebe Oma,\ndanke für das Paket!',
): Promise<MockOllama> {
  const installed = new Set<string>()
  const chats: MockOllama['chats'] = []

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
        : {}
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(data))
      }
      switch (req.url) {
        case '/api/version':
          return json(200, { version: '0.20.0-mock' })
        case '/api/tags':
          return json(200, { models: [...installed].map((name) => ({ name, model: name })) })
        case '/api/pull': {
          const model = String(body['model'])
          if (model.includes('gibtsnicht')) {
            res.writeHead(200, { 'content-type': 'application/x-ndjson' })
            res.end(`${JSON.stringify({ error: 'pull model manifest: file does not exist' })}\n`)
            return
          }
          res.writeHead(200, { 'content-type': 'application/x-ndjson' })
          const total = 6_100_000_000
          for (const completed of [0, total / 2, total]) {
            res.write(`${JSON.stringify({ status: 'pulling abc', completed, total })}\n`)
          }
          installed.add(model)
          res.end(`${JSON.stringify({ status: 'success' })}\n`)
          return
        }
        case '/api/delete':
          installed.delete(String(body['model']))
          return json(200, {})
        case '/api/chat': {
          const model = String(body['model'])
          if (!installed.has(model)) return json(404, { error: `model "${model}" not found` })
          chats.push(body as unknown as MockOllama['chats'][number])
          return json(200, {
            model,
            message: { role: 'assistant', content: `<think>lese…</think>${transcription}` },
            done: true,
          })
        }
        default:
          return json(404, { error: 'not found' })
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    installed,
    chats,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
