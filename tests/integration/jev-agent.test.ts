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
import { startMockAnthropic, type MockAnthropic } from '../../scripts/mock-anthropic'
import { startMockJev, type MockJev } from '../../scripts/mock-jev'

describe('Jev decision tool inside the agent (real runtime)', () => {
  let anthropic: MockAnthropic
  let jev: MockJev
  let dir: string
  let db: ReturnType<typeof openDatabase>
  let toolNames: string[] = []
  let systemPrompt = ''

  beforeAll(async () => {
    jev = await startMockJev()
    anthropic = await startMockAnthropic((raw) => {
      const body = raw as { tools?: { name: string }[]; messages?: unknown[]; system?: unknown }
      toolNames = (body.tools ?? []).map((t) => t.name)
      systemPrompt = JSON.stringify(body.system ?? '')
      const done = JSON.stringify(body.messages ?? []).includes('"tool_result"')
      return done
        ? { text: 'Das Ticket gehört zur IT und ist dringend.' }
        : {
            toolUse: {
              name: 'mcp__jev__evaluate',
              input: {
                state: 'Der Drucker im 2. Stock raucht.',
                questions: {
                  team: {
                    type: 'choice',
                    instructions: 'Welches Team?',
                    criteria: { it: 'IT', hr: 'HR' },
                  },
                  urgent: { type: 'noul', instructions: 'Ist es dringend?' },
                },
              },
            },
          }
    })
    dir = mkdtempSync(join(tmpdir(), 'aiw-jev-agent-'))
    db = openDatabase(join(dir, 'w.db'))
  })

  afterAll(async () => {
    await anthropic.close()
    await jev.close()
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  function manager(settings: Settings, secrets: SecretStore, events: AgentEvent[]) {
    return new SessionManager({
      getSettings: () => settings,
      secrets,
      chats: new ChatRepository(db),
      dataDir: dir,
      appVersion: 'test',
      executablePath: resolveClaudeExecutable(),
      jevEndpoint: jev.url,
      emit: (e) => events.push(e),
    })
  }

  async function run(m: SessionManager, chatId: string) {
    m.send({ chatId, prompt: 'Ordne das Ticket ein', attachments: [] })
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!m.isRunning(chatId)) {
          clearInterval(timer)
          resolve()
        }
      }, 50)
    })
  }

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    activeProvider: 'ollama',
    models: { ...DEFAULT_SETTINGS.models, ollama: 'mock-model' },
    webAccess: false,
  }

  it('offers Jev to the active (local) model and answers without a permission prompt', async () => {
    const secrets = new SecretStore(join(dir, 's1.json'), {
      isAvailable: () => true,
      encrypt: (s) => Buffer.from(s),
      decrypt: (b) => b.toString(),
    })
    secrets.set('typesafe', 'ts-test-key')
    const events: AgentEvent[] = []
    await run(manager({ ...settings, ollamaBaseUrl: anthropic.url }, secrets, events), 'j1')

    expect(toolNames).toContain('mcp__jev__evaluate')
    expect(systemPrompt).toContain('mcp__jev__evaluate')
    expect(events.some((e) => e.type === 'permission-request')).toBe(false)
    const result = events.find((e) => e.type === 'tool-result')
    expect(result).toMatchObject({ isError: false })
    const content = result && 'content' in result ? String(result.content) : ''
    expect(JSON.parse(content)).toMatchObject({
      answers: { team: { choice: 'it' }, urgent: { p_yes: 0.923 } },
    })
    expect(jev.requests.at(-1)?.body).toMatchObject({
      model: 'jev-latest',
      state: 'Der Drucker im 2. Stock raucht.',
    })
  }, 120_000)

  it('does not offer Jev without a key or when switched off', async () => {
    const secrets = new SecretStore(join(dir, 's2.json'), {
      isAvailable: () => true,
      encrypt: (s) => Buffer.from(s),
      decrypt: (b) => b.toString(),
    })
    await run(manager({ ...settings, ollamaBaseUrl: anthropic.url }, secrets, []), 'j2')
    expect(toolNames).not.toContain('mcp__jev__evaluate')
    // The model still knows Jev exists and how the user can switch it on.
    expect(systemPrompt).toContain('Kein TypeSafe-API-Key gespeichert.')

    secrets.set('typesafe', 'ts-test-key')
    await run(
      manager({ ...settings, ollamaBaseUrl: anthropic.url, jevEnabled: false }, secrets, []),
      'j3',
    )
    expect(toolNames).not.toContain('mcp__jev__evaluate')
  }, 120_000)
})
