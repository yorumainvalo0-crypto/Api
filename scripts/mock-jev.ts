import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

interface Question {
  type: string
  instructions: unknown
  criteria?: unknown
}

export interface MockJev {
  url: string
  /** Request bodies and auth headers received, in order. */
  requests: {
    auth: string | undefined
    body: { model: string; state: unknown; questions: Record<string, Question> }
  }[]
  /** Respond with this status to the next N requests (e.g. 429 to test retries). */
  failNext: (status: number, times?: number) => void
  close: () => Promise<void>
}

/** Minimal TypeSafe System One mock: deterministic answers per question type. */
export async function startMockJev(apiKey = 'ts-test-key'): Promise<MockJev> {
  const requests: MockJev['requests'] = []
  let failures: { status: number; times: number } | null = null

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.method !== 'POST' || req.url !== '/v1/systemone')
        return json(404, { error: 'not found' })
      if (failures && failures.times > 0) {
        failures.times--
        return json(failures.status, { error: 'busy' })
      }
      if (req.headers.authorization !== `Bearer ${apiKey}`) {
        return json(401, { error: { message: 'Invalid API key' } })
      }
      const body = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      ) as MockJev['requests'][number]['body']
      requests.push({ auth: req.headers.authorization, body })
      const answers: Record<string, unknown> = {}
      for (const [key, q] of Object.entries(body.questions)) {
        if (q.type === 'noul') answers[key] = { type: 'noul', noul: 0.9234 }
        else if (q.type === 'choice') {
          const options = Object.keys(q.criteria as Record<string, unknown>)
          const p = 1 / options.length
          answers[key] = {
            type: 'choice',
            choice: options[0],
            confidence: 0.8,
            probabilities: Object.fromEntries(options.map((o) => [o, p])),
          }
        } else if (q.type === 'score') {
          const levels = q.criteria as unknown[]
          answers[key] = {
            type: 'score',
            score: levels.length - 1.4,
            confidence: 0.7,
            legend: Object.fromEntries(levels.map((l, i) => [String(i), l])),
            probabilities: Object.fromEntries(levels.map((_, i) => [String(i), 1 / levels.length])),
          }
        } else return json(422, { detail: [{ loc: ['questions', key, 'type'], msg: 'bad type' }] })
      }
      json(200, { model: 'jev-1.13', answers, usage: { input_tokens: 42, output_tokens: 0 } })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1/systemone`,
    requests,
    failNext: (status, times = 1) => {
      failures = { status, times }
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
