import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gunzipSync } from 'node:zlib'
import { z } from 'zod'
import type { ProviderId } from '@shared/schemas/settings'
import type { UsageRepository } from '../storage/usage-repository'
import type { ModelTotals } from '../agent/usage'

/**
 * Token usage of interactive `claude` sessions in the terminal.
 *
 * Claude Code emits one OpenTelemetry log event `claude_code.api_request` per model call (model,
 * tokens, cost, session and prompt id), including calls that never reach the transcript (session
 * titles, the auto-mode classifier, subagents). The terminal wrapper points its OTLP/HTTP JSON log
 * exporter at a local endpoint of the app; nothing leaves the machine. The status line and the
 * transcript were checked as well: the status line only carries the session's total cost and the
 * last call's tokens, and the transcript's cumulative `cost-state` is only written on exit.
 */

/** One model call reported by Claude Code. */
export interface ApiRequestEvent {
  /** Terminal session (from the `aiw.terminal` resource attribute). */
  terminalId: string
  /** Claude Code session id. */
  sessionId: string
  /** Groups the calls of one user prompt; empty for calls outside a prompt. */
  promptId: string
  model: string
  totals: ModelTotals
}

const AnyValueSchema = z
  .object({
    stringValue: z.string().optional(),
    intValue: z.union([z.number(), z.string()]).optional(),
    doubleValue: z.union([z.number(), z.string()]).optional(),
  })
  .loose()
const AttributesSchema = z
  .array(z.object({ key: z.string(), value: AnyValueSchema.optional() }).loose())
  .optional()
const LogsRequestSchema = z
  .object({
    resourceLogs: z
      .array(
        z
          .object({
            resource: z.object({ attributes: AttributesSchema }).loose().optional(),
            scopeLogs: z
              .array(
                z
                  .object({
                    logRecords: z
                      .array(
                        z
                          .object({
                            body: AnyValueSchema.optional(),
                            attributes: AttributesSchema,
                          })
                          .loose(),
                      )
                      .optional(),
                  })
                  .loose(),
              )
              .optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose()

type Attributes = z.infer<typeof AttributesSchema>

function attributeMap(...lists: Attributes[]): Map<string, z.infer<typeof AnyValueSchema>> {
  const map = new Map<string, z.infer<typeof AnyValueSchema>>()
  for (const list of lists) for (const a of list ?? []) if (a.value) map.set(a.key, a.value)
  return map
}

function text(value: z.infer<typeof AnyValueSchema> | undefined): string {
  return value?.stringValue ?? ''
}

/** Numbers may arrive as JSON numbers or (int64 per OTLP/JSON) as strings. */
function num(value: z.infer<typeof AnyValueSchema> | undefined): number {
  const raw = value?.intValue ?? value?.doubleValue ?? value?.stringValue
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Extracts the `claude_code.api_request` events of an OTLP/HTTP JSON logs request. */
export function parseOtlpLogs(body: unknown): ApiRequestEvent[] {
  const parsed = LogsRequestSchema.safeParse(body)
  if (!parsed.success) return []
  const events: ApiRequestEvent[] = []
  for (const resourceLogs of parsed.data.resourceLogs ?? []) {
    const resource = resourceLogs.resource?.attributes
    for (const scope of resourceLogs.scopeLogs ?? []) {
      for (const record of scope.logRecords ?? []) {
        const attrs = attributeMap(resource, record.attributes)
        const name = text(record.body) || `claude_code.${text(attrs.get('event.name'))}`
        if (name !== 'claude_code.api_request') continue
        const terminalId = text(attrs.get('aiw.terminal'))
        const sessionId = text(attrs.get('session.id'))
        const model = text(attrs.get('model'))
        if (!terminalId || !model) continue
        events.push({
          terminalId,
          sessionId,
          promptId: text(attrs.get('prompt.id')),
          model,
          totals: {
            inputTokens: num(attrs.get('input_tokens')),
            outputTokens: num(attrs.get('output_tokens')),
            cacheReadTokens: num(attrs.get('cache_read_tokens')),
            cacheWriteTokens: num(attrs.get('cache_creation_tokens')),
            costUsd: num(attrs.get('cost_usd')),
          },
        })
      }
    }
  }
  return events
}

interface OpenTurn {
  terminalId: string
  promptId: string
  provider: ProviderId
  models: Record<string, ModelTotals>
  timer: NodeJS.Timeout | undefined
}

export interface TerminalUsageCollectorDeps {
  usage: Pick<UsageRepository, 'record'>
  /** Provider a terminal session was started with; undefined for unknown sessions. */
  providerOf: (terminalId: string) => ProviderId | undefined
  /** A turn is logged after this long without new calls (it may still continue later). */
  idleMs?: number
}

/**
 * Collects model calls per user prompt and logs each prompt once as an `agent: 'terminal'` usage
 * entry for the chat id `terminal:<terminal session id>`, like one answer in the chat.
 */
export class TerminalUsageCollector {
  /** Open turn per Claude Code session (`terminalId` + `sessionId`). */
  private readonly turns = new Map<string, OpenTurn>()

  constructor(private readonly deps: TerminalUsageCollectorDeps) {}

  add(events: ApiRequestEvent[]): void {
    for (const event of events) {
      const provider = this.deps.providerOf(event.terminalId)
      if (!provider) continue
      const key = `${event.terminalId}\u0000${event.sessionId}`
      let turn = this.turns.get(key)
      if (turn && turn.promptId !== event.promptId) {
        this.flushKey(key)
        turn = undefined
      }
      if (!turn) {
        turn = {
          terminalId: event.terminalId,
          promptId: event.promptId,
          provider,
          models: {},
          timer: undefined,
        }
        this.turns.set(key, turn)
      }
      const sum = (turn.models[event.model] ??= {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      })
      sum.inputTokens += event.totals.inputTokens
      sum.outputTokens += event.totals.outputTokens
      sum.cacheReadTokens += event.totals.cacheReadTokens
      sum.cacheWriteTokens += event.totals.cacheWriteTokens
      // Local models are free; Claude Code would price them like hosted ones.
      if (provider !== 'ollama') sum.costUsd += event.totals.costUsd
      if (turn.timer) clearTimeout(turn.timer)
      turn.timer = setTimeout(() => this.flushKey(key), this.deps.idleMs ?? 15_000)
      turn.timer.unref()
    }
  }

  /** Logs the open turns of one terminal session (e.g. after it ended). */
  flushTerminal(terminalId: string): void {
    for (const [key, turn] of this.turns) if (turn.terminalId === terminalId) this.flushKey(key)
  }

  flushAll(): void {
    for (const key of [...this.turns.keys()]) this.flushKey(key)
  }

  private flushKey(key: string): void {
    const turn = this.turns.get(key)
    if (!turn) return
    this.turns.delete(key)
    if (turn.timer) clearTimeout(turn.timer)
    if (Object.keys(turn.models).length === 0) return
    this.deps.usage.record({
      chatId: `terminal:${turn.terminalId}`,
      provider: turn.provider,
      models: turn.models,
      agent: 'terminal',
    })
  }
}

const MAX_BODY_BYTES = 8 * 1024 * 1024

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Minimal OTLP/HTTP JSON logs receiver on 127.0.0.1 with a random bearer token per app run.
 * Started lazily with the first terminal session.
 */
export class OtlpLogsReceiver {
  private server: Server | undefined
  private starting: Promise<{ endpoint: string; token: string }> | undefined
  private readonly token = randomBytes(24).toString('hex')

  constructor(private readonly onEvents: (events: ApiRequestEvent[]) => void) {}

  /** Starts the server once and returns the logs endpoint URL and token. */
  start(): Promise<{ endpoint: string; token: string }> {
    this.starting ??= new Promise((resolve, reject) => {
      const expected = Buffer.from(`Bearer ${this.token}`)
      const server = createServer((req, res) => {
        const auth = Buffer.from(req.headers.authorization ?? '')
        const authorized = auth.length === expected.length && timingSafeEqual(auth, expected)
        if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/v1/logs') {
          res.writeHead(404).end()
          return
        }
        if (!authorized) {
          res.writeHead(401).end()
          return
        }
        readBody(req)
          .then((raw) => {
            const data = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
            this.onEvents(parseOtlpLogs(JSON.parse(data.toString('utf8'))))
            res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
          })
          .catch(() => {
            if (!res.headersSent) res.writeHead(400).end()
          })
      })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        this.server = server
        resolve({ endpoint: `http://127.0.0.1:${port}/v1/logs`, token: this.token })
      })
      // Never keep the app (or a test run) alive just for this server.
      server.unref()
    })
    return this.starting
  }

  close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.starting = undefined
    if (!server) return Promise.resolve()
    return new Promise((resolve) => {
      server.close(() => resolve())
      // The exporter keeps its connection alive; do not wait for it to time out.
      server.closeAllConnections()
    })
  }
}
