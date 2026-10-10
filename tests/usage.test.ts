import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { usageDelta, type ModelTotals } from '../src/main/agent/usage'
import { contextFromResult, parseContextResponse } from '../src/main/agent/context'
import { openDatabase } from '../src/main/storage/database'
import { rangeStart, UsageRepository } from '../src/main/storage/usage-repository'
import { migrateSettings, SettingsStore } from '../src/main/storage/settings-store'

const totals = (input: number, output: number, cost: number): ModelTotals => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: cost,
})

describe('usage deltas', () => {
  it('subtracts the previous totals of the same session', () => {
    const delta = usageDelta({ sessionId: 's1', models: { sonnet: totals(100, 10, 0.5) } }, 's1', {
      sonnet: totals(250, 30, 1.25),
      haiku: totals(5, 1, 0.01),
    })
    expect(delta).toEqual({ sonnet: totals(150, 20, 0.75), haiku: totals(5, 1, 0.01) })
  })

  it('starts fresh for a new session or shrinking totals', () => {
    const previous = { sessionId: 's1', models: { sonnet: totals(100, 10, 0.5) } }
    expect(usageDelta(previous, 's2', { sonnet: totals(120, 12, 0.6) })).toEqual({
      sonnet: totals(120, 12, 0.6),
    })
    expect(usageDelta(previous, 's1', { sonnet: totals(20, 2, 0.1) })).toEqual({
      sonnet: totals(20, 2, 0.1),
    })
  })

  it('drops models without new usage', () => {
    const previous = { sessionId: 's1', models: { haiku: totals(5, 1, 0.01) } }
    expect(usageDelta(previous, 's1', { haiku: totals(5, 1, 0.01) })).toEqual({})
  })
})

describe('context usage', () => {
  it('parses the runtime answer in camelCase and snake_case', () => {
    const camel = parseContextResponse(
      {
        totalTokens: 50_000,
        maxTokens: 200_000,
        percentage: 25,
        model: 'claude-sonnet-4-5',
        categories: [
          { name: 'Messages', tokens: 40_000, kind: 'used', color: 'x' },
          { name: 'System prompt', tokens: 0, kind: 'used' },
          { name: 'Free space', tokens: 150_000, kind: 'free' },
        ],
      },
      1,
    )
    expect(camel).toEqual({
      model: 'claude-sonnet-4-5',
      usedTokens: 50_000,
      maxTokens: 200_000,
      percentage: 25,
      categories: [
        { name: 'Messages', tokens: 40_000, kind: 'used' },
        { name: 'Free space', tokens: 150_000, kind: 'free' },
      ],
      updatedAt: 1,
    })
    expect(
      parseContextResponse({ total_tokens: 10, raw_max_tokens: 100, categories: [] })?.percentage,
    ).toBe(10)
    expect(parseContextResponse({ categories: [] })).toBeUndefined()
  })

  it('estimates from the last call when no breakdown is available', () => {
    const c = contextFromResult(
      { input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 0 },
      { m: { contextWindow: 200_000 } },
      'm',
      1,
    )
    expect(c).toMatchObject({ usedTokens: 10_000, maxTokens: 200_000, percentage: 5 })
  })
})

describe('usage repository', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    dir = ''
  })

  it('aggregates by provider, model and time', () => {
    const db = openDatabase(':memory:')
    const usage = new UsageRepository(db)
    const now = new Date(2026, 9, 10, 15, 30)
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 5).getTime()
    usage.record({
      chatId: 'a',
      provider: 'anthropic',
      models: { sonnet: totals(1000, 200, 0.5), haiku: totals(50, 5, 0.01) },
      createdAt: at(10, 9),
    })
    usage.record({
      chatId: 'b',
      provider: 'ollama',
      models: { 'qwen3:8b': totals(300, 30, 0) },
      createdAt: at(10, 14),
    })
    usage.record({
      chatId: 'a',
      provider: 'anthropic',
      models: { sonnet: totals(500, 100, 0.25) },
      createdAt: at(8, 12),
    })

    const today = usage.summary('today', now)
    expect(today.granularity).toBe('hour')
    expect(today.series).toHaveLength(24)
    expect(today.total).toMatchObject({ requests: 2, inputTokens: 1350, outputTokens: 235 })
    expect(today.total.costUsd).toBeCloseTo(0.51)
    expect(today.series[9]?.costByProvider.anthropic).toBeCloseTo(0.51)
    expect(today.series[14]?.tokensByProvider.ollama).toBe(330)
    expect(today.byProvider.map((p) => p.provider)).toEqual(['anthropic', 'ollama'])

    const week = usage.summary('7d', now)
    expect(week.granularity).toBe('day')
    expect(week.series).toHaveLength(7)
    expect(week.series.at(-3)?.costByProvider.anthropic).toBeCloseTo(0.25)
    expect(week.byModel[0]).toMatchObject({ provider: 'anthropic', model: 'sonnet', requests: 2 })
    expect(week.byModel[0]?.costUsd).toBeCloseTo(0.75)
    expect(rangeStart('month', now)).toBe(new Date(2026, 9, 1).getTime())
    db.close()
  })

  it('stores snapshots and the last context per chat', () => {
    const db = openDatabase(':memory:')
    const usage = new UsageRepository(db)
    expect(usage.getSnapshot('c')).toBeUndefined()
    usage.setSnapshot('c', { sessionId: 's', models: { m: totals(1, 2, 3) } })
    usage.setSnapshot('c', { sessionId: 's2', models: { m: totals(4, 5, 6) } })
    expect(usage.getSnapshot('c')).toEqual({ sessionId: 's2', models: { m: totals(4, 5, 6) } })
    const context = {
      model: 'm',
      usedTokens: 1,
      maxTokens: 2,
      percentage: 50,
      categories: [],
      updatedAt: 3,
    }
    usage.setContext('c', context)
    expect(usage.getContext('c')).toEqual(context)
    expect(usage.getContext('x')).toBeNull()
    db.close()
  })

  it('turns cumulative costs of old databases into per-answer costs', () => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-usage-'))
    const path = join(dir, 'old.db')
    // A v2 database as written by the previous version.
    const old = new DatabaseSync(path)
    old.exec(`
      CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, provider TEXT NOT NULL,
        model TEXT NOT NULL, sdk_session_id TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, mode TEXT NOT NULL DEFAULT 'chat', project_path TEXT,
        permission_mode TEXT NOT NULL DEFAULT 'default');
      CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL,
        text TEXT NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]',
        tools_json TEXT NOT NULL DEFAULT '[]', error TEXT, cost_usd REAL, duration_ms INTEGER,
        created_at INTEGER NOT NULL, parts_json TEXT NOT NULL DEFAULT '[]');
      INSERT INTO chats VALUES ('c', 'Alt', 'anthropic', 'Standard', 's', 1, 1, 'chat', NULL, 'default');
      INSERT INTO messages (id, chat_id, role, text, cost_usd, created_at) VALUES
        ('u1', 'c', 'user', 'a', NULL, 1),
        ('a1', 'c', 'assistant', 'x', 0.10, 2),
        ('a2', 'c', 'assistant', 'y', 0.25, 4),
        ('a3', 'c', 'assistant', 'z', 0.05, 6);
      PRAGMA user_version = 2;
    `)
    old.close()

    const db = openDatabase(path)
    const costs = db
      .prepare(`SELECT cost_usd FROM messages WHERE role = 'assistant' ORDER BY created_at`)
      .all()
      .map((r) => (r as { cost_usd: number }).cost_usd)
    expect(costs.map((c) => Number(c.toFixed(4)))).toEqual([0.1, 0.15, 0.05])
    const summary = new UsageRepository(db).summary('all', new Date(2026, 9, 10))
    expect(summary.total.requests).toBe(3)
    expect(summary.total.costUsd).toBeCloseTo(0.3)
    db.close()
  })
})

describe('settings migration', () => {
  it('switches old "system" theme files to the new dark default once', () => {
    expect(migrateSettings({ theme: 'system' })).toMatchObject({
      theme: 'dark',
      settingsVersion: 2,
    })
    expect(migrateSettings({ theme: 'light' })).toMatchObject({ theme: 'light' })
    expect(migrateSettings({ theme: 'system', settingsVersion: 2 })).toMatchObject({
      theme: 'system',
    })
  })

  it('applies to settings files on disk', () => {
    const d = mkdtempSync(join(tmpdir(), 'aiw-settings-'))
    const file = join(d, 'settings.json')
    writeFileSync(file, JSON.stringify({ theme: 'system', webAccess: false }))
    const settings = new SettingsStore(file).get()
    expect(settings.theme).toBe('dark')
    expect(settings.webAccess).toBe(false)
    rmSync(d, { recursive: true, force: true })
  })
})
