import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../src/main/storage/database'
import { UsageRepository } from '../src/main/storage/usage-repository'
import {
  OtlpLogsReceiver,
  parseOtlpLogs,
  TerminalUsageCollector,
  type ApiRequestEvent,
} from '../src/main/terminal/usage'

type Attr = { key: string; value: Record<string, unknown> }
const s = (key: string, value: string): Attr => ({ key, value: { stringValue: value } })
const i = (key: string, value: number | string): Attr => ({ key, value: { intValue: value } })

/** An OTLP/HTTP JSON logs request as Claude Code 2.1 sends it (shape taken from a real export). */
function logs(records: { body: string; attributes: Attr[] }[], terminal = 'term-1') {
  return {
    resourceLogs: [
      {
        resource: { attributes: [s('aiw.terminal', terminal), s('service.name', 'claude-code')] },
        scopeLogs: [
          {
            scope: { name: 'com.anthropic.claude_code.events', version: '2.1.296' },
            logRecords: records.map((r) => ({
              timeUnixNano: '1791660399109000000',
              body: { stringValue: r.body },
              attributes: r.attributes,
            })),
          },
        ],
      },
    ],
  }
}

function apiRequest(opts: {
  session?: string
  prompt?: string
  model?: string
  input?: number | string
  cost?: number
}): { body: string; attributes: Attr[] } {
  return {
    body: 'claude_code.api_request',
    attributes: [
      s('session.id', opts.session ?? 'sess-1'),
      s('event.name', 'api_request'),
      s('prompt.id', opts.prompt ?? 'p1'),
      s('model', opts.model ?? 'claude-sonnet-4-5'),
      i('input_tokens', opts.input ?? 10),
      i('output_tokens', 5),
      i('cache_read_tokens', '100'),
      i('cache_creation_tokens', 20),
      { key: 'cost_usd', value: { doubleValue: opts.cost ?? 0.01 } },
      s('query_source', 'repl_main_thread'),
    ],
  }
}

describe('parseOtlpLogs', () => {
  it('extracts api_request events with tokens and cost and skips other events', () => {
    const events = parseOtlpLogs(
      logs([
        { body: 'claude_code.user_prompt', attributes: [s('prompt', '<REDACTED>')] },
        apiRequest({ input: '1234' }),
      ]),
    )
    expect(events).toEqual([
      {
        terminalId: 'term-1',
        sessionId: 'sess-1',
        promptId: 'p1',
        model: 'claude-sonnet-4-5',
        totals: {
          inputTokens: 1234,
          outputTokens: 5,
          cacheReadTokens: 100,
          cacheWriteTokens: 20,
          costUsd: 0.01,
        },
      },
    ])
  })

  it('ignores foreign or malformed payloads', () => {
    expect(parseOtlpLogs(null)).toEqual([])
    expect(parseOtlpLogs({ resourceLogs: 'x' })).toEqual([])
    // Without the terminal attribute the event does not come from an app terminal.
    expect(parseOtlpLogs(logs([apiRequest({})], ''))).toEqual([])
  })
})

describe('TerminalUsageCollector', () => {
  afterEach(() => vi.useRealTimers())

  const event = (patch: Partial<ApiRequestEvent> = {}): ApiRequestEvent => ({
    terminalId: 't1',
    sessionId: 's1',
    promptId: 'p1',
    model: 'claude-sonnet-4-5',
    totals: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.5,
    },
    ...patch,
  })

  it('logs one entry per prompt with all its model calls', () => {
    const db = openDatabase(':memory:')
    const usage = new UsageRepository(db)
    const collector = new TerminalUsageCollector({ usage, providerOf: () => 'anthropic' })
    collector.add([event(), event({ model: 'claude-haiku-4-5' }), event()])
    // A new prompt closes the previous one.
    collector.add([event({ promptId: 'p2' })])
    let summary = usage.summary('today')
    expect(summary.total).toMatchObject({ requests: 1, inputTokens: 30, costUsd: 1.5 })
    expect(summary.byAgent).toEqual([expect.objectContaining({ agent: 'terminal', requests: 1 })])
    collector.flushTerminal('t1')
    summary = usage.summary('today')
    expect(summary.total).toMatchObject({ requests: 2, inputTokens: 40 })
    expect(summary.byModel.map((m) => m.model).sort()).toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-4-5',
    ])
    const chatIds = db.prepare('SELECT DISTINCT chat_id FROM usage').all() as { chat_id: string }[]
    expect(chatIds).toEqual([{ chat_id: 'terminal:t1' }])
    db.close()
  })

  it('keeps sessions apart, prices Ollama at zero, ignores unknown terminals', () => {
    const record = vi.fn<UsageRepository['record']>()
    const providers: Record<string, 'ollama' | 'openrouter'> = { t1: 'ollama', t2: 'openrouter' }
    const collector = new TerminalUsageCollector({
      usage: { record },
      providerOf: (id) => providers[id],
    })
    collector.add([
      event(),
      event({ sessionId: 's2' }),
      event({ terminalId: 't2' }),
      event({ terminalId: 'fremd' }),
    ])
    collector.flushAll()
    expect(record).toHaveBeenCalledTimes(3)
    const calls = record.mock.calls.map(([entry]) => entry)
    expect(calls.filter((c) => c.provider === 'ollama')).toHaveLength(2)
    for (const c of calls) {
      expect(c.agent).toBe('terminal')
      const cost = c.models['claude-sonnet-4-5']?.costUsd
      expect(cost).toBe(c.provider === 'ollama' ? 0 : 0.5)
    }
  })

  it('logs an idle prompt after the timeout', () => {
    vi.useFakeTimers()
    const record = vi.fn<UsageRepository['record']>()
    const collector = new TerminalUsageCollector({
      usage: { record },
      providerOf: () => 'anthropic',
      idleMs: 1000,
    })
    collector.add([event()])
    vi.advanceTimersByTime(900)
    collector.add([event()])
    vi.advanceTimersByTime(900)
    expect(record).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(record).toHaveBeenCalledTimes(1)
  })
})

describe('OtlpLogsReceiver', () => {
  it('accepts authorized JSON (also gzip) and rejects everything else', async () => {
    const received: ApiRequestEvent[] = []
    const receiver = new OtlpLogsReceiver((events) => received.push(...events))
    const { endpoint, token } = await receiver.start()
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/logs$/)
    expect(await receiver.start()).toEqual({ endpoint, token })
    const body = JSON.stringify(logs([apiRequest({})]))
    const post = (init: RequestInit, url = endpoint) => fetch(url, { method: 'POST', ...init })
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

    expect((await post({ body, headers: auth })).status).toBe(200)
    expect(
      (
        await post({
          body: gzipSync(body),
          headers: { ...auth, 'content-encoding': 'gzip' },
        })
      ).status,
    ).toBe(200)
    expect((await post({ body, headers: { authorization: 'Bearer falsch' } })).status).toBe(401)
    expect((await post({ body })).status).toBe(401)
    expect((await post({ body, headers: auth }, endpoint.replace('logs', 'metrics'))).status).toBe(
      404,
    )
    expect((await post({ body: '{kaputt', headers: auth })).status).toBe(400)
    expect(received).toHaveLength(2)
    await receiver.close()
  })
})
