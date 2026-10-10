import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type CoworkRole, type Settings } from '@shared/schemas/settings'
import type { AgentEvent } from '@shared/schemas/agent'
import { SessionManager } from '../../src/main/agent/session-manager'
import { resolveClaudeExecutable } from '../../src/main/agent/executable'
import { ChatRepository } from '../../src/main/storage/chat-repository'
import { openDatabase } from '../../src/main/storage/database'
import { SecretStore } from '../../src/main/storage/secret-store'
import { UsageRepository } from '../../src/main/storage/usage-repository'
import { startMockAnthropic, type MockAnthropic } from '../../scripts/mock-anthropic'
import { startMockJev, type MockJev } from '../../scripts/mock-jev'

const ROLES: CoworkRole[] = [
  {
    id: 'koordinator',
    name: 'Koordinator',
    description: 'Plant und verteilt Aufgaben.',
    provider: 'ollama',
    model: 'mock-main',
    effort: 'default',
  },
  {
    id: 'experte',
    name: 'Experte',
    description: 'Schwierige Teilaufgaben.',
    provider: 'ollama',
    model: 'mock-expert',
    effort: 'default',
  },
]

describe('Cowork mode with Jev routing and subagents (real runtime)', () => {
  let anthropic: MockAnthropic
  let jev: MockJev
  let dir: string
  let db: ReturnType<typeof openDatabase>
  const models: string[] = []

  beforeAll(async () => {
    jev = await startMockJev()
    anthropic = await startMockAnthropic((raw) => {
      const body = raw as { model?: string; messages?: unknown[]; system?: unknown }
      models.push(body.model ?? '')
      const system = JSON.stringify(body.system ?? '')
      if (system.includes('Subagent im Cowork-Modus')) return { text: 'Teilergebnis vom Experten' }
      const done = JSON.stringify(body.messages ?? []).includes('"tool_result"')
      return done
        ? { text: 'Zusammengefasst: erledigt.' }
        : {
            toolUse: {
              name: 'mcp__cowork__delegate',
              input: { role: 'experte', task: 'Prüfe die Rechnung 2+2', context: 'Kontext' },
            },
          }
    })
    dir = mkdtempSync(join(tmpdir(), 'aiw-cowork-'))
    db = openDatabase(join(dir, 'w.db'))
  })

  afterAll(async () => {
    await anthropic.close()
    await jev.close()
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('routes with Jev, runs a subagent with its own model and logs usage per agent', async () => {
    const secrets = new SecretStore(join(dir, 's.json'), {
      isAvailable: () => true,
      encrypt: (s) => Buffer.from(s),
      decrypt: (b) => b.toString(),
    })
    secrets.set('typesafe', 'ts-test-key')
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      activeProvider: 'ollama',
      ollamaBaseUrl: anthropic.url,
      webAccess: false,
      coworkEnabled: true,
      coworkRoles: ROLES,
      coworkDefaultRole: 'koordinator',
    }
    const events: AgentEvent[] = []
    const usage = new UsageRepository(db)
    const chats = new ChatRepository(db)
    const manager = new SessionManager({
      getSettings: () => settings,
      secrets,
      chats,
      usage,
      dataDir: dir,
      appVersion: 'test',
      executablePath: resolveClaudeExecutable(),
      jevEndpoint: jev.url,
      emit: (e) => events.push(e),
    })

    manager.send({ chatId: 'c1', prompt: 'Rechne und prüfe 2+2', attachments: [] })
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!manager.isRunning('c1')) {
          clearInterval(timer)
          resolve()
        }
      }, 50)
    })

    // Jev picked the first role (the mock answers with the first option).
    expect(events.find((e) => e.type === 'route')).toMatchObject({
      route: { roleId: 'koordinator', by: 'jev', model: 'mock-main', splitProbability: 0.9234 },
    })
    expect(events.some((e) => e.type === 'permission-request')).toBe(false)
    const result = events.find((e) => e.type === 'tool-result')
    expect(result).toMatchObject({ isError: false })
    expect(result && 'content' in result ? result.content : '').toContain(
      'Teilergebnis vom Experten',
    )
    // Main agent and subagent ran with their own models.
    expect(models).toContain('mock-main')
    expect(models).toContain('mock-expert')

    const agents = usage
      .summary('today')
      .byAgent.map((a) => a.agent)
      .sort()
    expect(agents).toEqual(['main', 'router', 'subagent:Experte'])
    expect(
      usage
        .summary('today')
        .byProvider.map((p) => p.provider)
        .sort(),
    ).toEqual(['ollama', 'typesafe'])
    // The route is stored with the answer.
    const saved = chats.get('c1')?.messages.at(-1)
    expect(saved?.parts[0]).toMatchObject({ type: 'route', route: { roleName: 'Koordinator' } })
    expect(saved?.parts.at(-1)).toMatchObject({ type: 'text', text: 'Zusammengefasst: erledigt.' })
  }, 120_000)
})
