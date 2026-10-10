import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { ProviderIdSchema, type ProviderId } from '@shared/schemas/settings'
import {
  ContextUsageSchema,
  type ContextUsage,
  type ProviderAmounts,
  type UsageRange,
  type UsageSummary,
  type UsageTotals,
} from '@shared/schemas/usage'
import type { ModelTotals, UsageSnapshot } from '../agent/usage'

const UsageRowSchema = z.object({
  request_id: z.string(),
  provider: ProviderIdSchema.catch('anthropic'),
  model: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  cost_usd: z.number(),
  created_at: z.number(),
  agent: z.string().catch('main'),
})
type UsageRow = z.infer<typeof UsageRowSchema>

const SnapshotSchema = z.object({
  sessionId: z.string(),
  models: z.record(
    z.string(),
    z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadTokens: z.number(),
      cacheWriteTokens: z.number(),
      costUsd: z.number(),
    }),
  ),
})

/** Start of a usage range in local time (epoch ms), or null for all time. */
export function rangeStart(range: UsageRange, now = new Date()): number | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  switch (range) {
    case 'today':
      return today.getTime()
    case '7d':
      return today.getTime() - 6 * 86_400_000
    case '30d':
      return today.getTime() - 29 * 86_400_000
    case 'month':
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    case 'all':
      return null
  }
}

interface SeriesPoint {
  start: number
  requestIds: Set<string>
  costByProvider: ProviderAmounts
  tokensByProvider: ProviderAmounts
}

const zeroAmounts = (): ProviderAmounts => ({ anthropic: 0, openrouter: 0, ollama: 0 })

/** Empty hourly (today) or daily buckets from `from` up to now, in local time. */
function buildSeries(granularity: 'hour' | 'day', from: number, now: Date): SeriesPoint[] {
  const points: SeriesPoint[] = []
  const first = new Date(from)
  const cursor = new Date(first.getFullYear(), first.getMonth(), first.getDate())
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  // Show at least a week so a fresh install does not render a single bar.
  if (granularity === 'day') {
    const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)
    if (cursor > weekAgo) cursor.setTime(weekAgo.getTime())
  }
  while (cursor < end && points.length < 3700) {
    points.push({
      start: cursor.getTime(),
      requestIds: new Set(),
      costByProvider: zeroAmounts(),
      tokensByProvider: zeroAmounts(),
    })
    if (granularity === 'hour') cursor.setHours(cursor.getHours() + 1)
    else cursor.setDate(cursor.getDate() + 1)
  }
  return points
}

function addToSeries(series: SeriesPoint[], row: UsageRow): void {
  // Buckets are sorted; find the last one starting at or before the row.
  let lo = 0
  let hi = series.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((series[mid]?.start ?? Infinity) <= row.created_at) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  const point = series[found]
  if (!point) return
  point.requestIds.add(row.request_id)
  point.costByProvider[row.provider] += row.cost_usd
  point.tokensByProvider[row.provider] += row.input_tokens + row.output_tokens
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  }
}

/** Aggregates rows; requests are counted once per answer even with several model calls. */
class Bucket {
  readonly totals = emptyTotals()
  private readonly requests = new Set<string>()

  add(row: UsageRow): void {
    this.requests.add(row.request_id)
    this.totals.requests = this.requests.size
    this.totals.inputTokens += row.input_tokens
    this.totals.outputTokens += row.output_tokens
    this.totals.cacheReadTokens += row.cache_read_tokens
    this.totals.cacheWriteTokens += row.cache_write_tokens
    this.totals.costUsd += row.cost_usd
  }
}

/** Persistent log of tokens and costs per provider and model. */
export class UsageRepository {
  constructor(private readonly db: DatabaseSync) {}

  getSnapshot(chatId: string): UsageSnapshot | undefined {
    const row = this.db
      .prepare('SELECT session_id, models_json FROM usage_snapshots WHERE chat_id = ?')
      .get(chatId) as { session_id: string; models_json: string } | undefined
    if (!row) return undefined
    try {
      const models: unknown = JSON.parse(row.models_json)
      const parsed = SnapshotSchema.safeParse({ sessionId: row.session_id, models })
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  setSnapshot(chatId: string, snapshot: UsageSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO usage_snapshots (chat_id, session_id, models_json) VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id,
           models_json = excluded.models_json`,
      )
      .run(chatId, snapshot.sessionId, JSON.stringify(snapshot.models))
  }

  getContext(chatId: string): ContextUsage | null {
    const row = this.db
      .prepare('SELECT context_json FROM chat_context WHERE chat_id = ?')
      .get(chatId) as { context_json: string } | undefined
    if (!row) return null
    try {
      const parsed = ContextUsageSchema.safeParse(JSON.parse(row.context_json))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  setContext(chatId: string, context: ContextUsage): void {
    this.db
      .prepare(
        `INSERT INTO chat_context (chat_id, context_json) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET context_json = excluded.context_json`,
      )
      .run(chatId, JSON.stringify(context))
  }

  /** Logs what one answer used, one row per model. */
  record(entry: {
    chatId: string
    provider: ProviderId
    models: Record<string, ModelTotals>
    createdAt?: number
    /** Who used it: 'main' (default), a Cowork role name, 'router' or 'terminal'. */
    agent?: string
  }): void {
    const requestId = randomUUID()
    const createdAt = entry.createdAt ?? Date.now()
    const insert = this.db.prepare(
      `INSERT INTO usage (id, request_id, chat_id, provider, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, created_at, agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const [model, t] of Object.entries(entry.models)) {
      insert.run(
        randomUUID(),
        requestId,
        entry.chatId,
        entry.provider,
        model,
        t.inputTokens,
        t.outputTokens,
        t.cacheReadTokens,
        t.cacheWriteTokens,
        t.costUsd,
        createdAt,
        entry.agent ?? 'main',
      )
    }
  }

  summary(range: UsageRange, now = new Date()): UsageSummary {
    const since = rangeStart(range, now)
    const rows = (
      since === null
        ? this.db.prepare('SELECT * FROM usage ORDER BY created_at').all()
        : this.db
            .prepare('SELECT * FROM usage WHERE created_at >= ? ORDER BY created_at')
            .all(since)
    ).flatMap((raw) => {
      const parsed = UsageRowSchema.safeParse(raw)
      return parsed.success ? [parsed.data] : []
    })

    const total = new Bucket()
    const providers = new Map<ProviderId, Bucket>()
    const models = new Map<string, { provider: ProviderId; model: string; bucket: Bucket }>()
    const agents = new Map<string, Bucket>()
    const granularity = range === 'today' ? 'hour' : 'day'
    const series = buildSeries(granularity, since ?? rows[0]?.created_at ?? now.getTime(), now)
    const bucket = <K>(map: Map<K, Bucket>, key: K) => {
      let b = map.get(key)
      if (!b) map.set(key, (b = new Bucket()))
      return b
    }
    for (const row of rows) {
      total.add(row)
      bucket(providers, row.provider).add(row)
      bucket(agents, row.agent).add(row)
      addToSeries(series, row)
      const key = `${row.provider}\u0000${row.model}`
      let m = models.get(key)
      if (!m)
        models.set(key, (m = { provider: row.provider, model: row.model, bucket: new Bucket() }))
      m.bucket.add(row)
    }

    const byCost = (a: UsageTotals, b: UsageTotals) =>
      b.costUsd - a.costUsd || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)
    return {
      range,
      since,
      total: total.totals,
      byProvider: [...providers].map(([provider, b]) => ({ provider, ...b.totals })).sort(byCost),
      byModel: [...models.values()]
        .map((m) => ({ provider: m.provider, model: m.model, ...m.bucket.totals }))
        .sort(byCost),
      byAgent: [...agents].map(([agent, b]) => ({ agent, ...b.totals })).sort(byCost),
      granularity,
      series: series.map(({ requestIds, ...point }) => ({ ...point, requests: requestIds.size })),
    }
  }
}
