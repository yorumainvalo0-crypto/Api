import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/schemas/settings'
import type { AgentEvent } from '@shared/schemas/agent'
import { SessionManager } from '../../src/main/agent/session-manager'
import { resolveClaudeExecutable } from '../../src/main/agent/executable'
import { ChatRepository } from '../../src/main/storage/chat-repository'
import { openDatabase } from '../../src/main/storage/database'
import { SecretStore } from '../../src/main/storage/secret-store'
import { UsageRepository } from '../../src/main/storage/usage-repository'
import { startMockAnthropic, type MockAnthropic } from '../../scripts/mock-anthropic'

describe('usage and context tracking (real runtime)', () => {
  let mock: MockAnthropic
  let dir: string
  let db: ReturnType<typeof openDatabase>

  beforeAll(async () => {
    mock = await startMockAnthropic(() => ({ text: 'Antwort' }))
    dir = mkdtempSync(join(tmpdir(), 'aiw-usage-agent-'))
    db = openDatabase(join(dir, 'w.db'))
  })

  afterAll(async () => {
    await mock.close()
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('logs each answer once (not the session total) and reports the context', async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      activeProvider: 'ollama',
      ollamaBaseUrl: mock.url,
      models: { ...DEFAULT_SETTINGS.models, ollama: 'mock-model' },
      webAccess: false,
    }
    const events: AgentEvent[] = []
    const usage = new UsageRepository(db)
    const manager = new SessionManager({
      getSettings: () => settings,
      secrets: new SecretStore(join(dir, 's.json'), {
        isAvailable: () => true,
        encrypt: (s) => Buffer.from(s),
        decrypt: (b) => b.toString(),
      }),
      chats: new ChatRepository(db),
      usage,
      dataDir: dir,
      appVersion: 'test',
      executablePath: resolveClaudeExecutable(),
      emit: (e) => events.push(e),
    })

    for (const prompt of ['Eins', 'Zwei', 'Drei']) {
      const before = events.filter((e) => e.type === 'done').length
      manager.send({ chatId: 'u1', prompt, attachments: [] })
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (events.filter((e) => e.type === 'done').length > before && !manager.isRunning('u1')) {
            clearInterval(timer)
            resolve()
          }
        }, 50)
      })
    }

    // The mock reports 10 input / 5 output tokens per call; resumed sessions report running
    // totals, which must not be counted again.
    const summary = usage.summary('today')
    expect(summary.total).toMatchObject({ requests: 3, inputTokens: 30, outputTokens: 15 })
    expect(summary.total.costUsd).toBe(0)
    expect(summary.byProvider.map((p) => p.provider)).toEqual(['ollama'])
    expect(
      events.filter((e) => e.type === 'result').map((e) => 'costUsd' in e && e.costUsd),
    ).toEqual([0, 0, 0])

    const contexts = events.flatMap((e) => (e.type === 'context' ? [e.context] : []))
    expect(contexts).toHaveLength(3)
    expect(contexts[2]?.maxTokens).toBeGreaterThan(0)
    expect(usage.getContext('u1')).toEqual(contexts[2])
  }, 120_000)
})
