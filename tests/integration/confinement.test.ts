import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { DEFAULT_SETTINGS, type Settings } from '@shared/schemas/settings'
import type { AgentEvent, PermissionDecision } from '@shared/schemas/agent'
import type { AgentPermissionMode } from '@shared/schemas/chat'
import { SessionManager } from '../../src/main/agent/session-manager'
import { resolveClaudeExecutable } from '../../src/main/agent/executable'
import { buildProviderRuntime } from '../../src/main/agent/providers'
import { sandboxStatus } from '../../src/main/agent/sandbox'
import { ChatRepository } from '../../src/main/storage/chat-repository'
import { openDatabase } from '../../src/main/storage/database'
import { SecretStore } from '../../src/main/storage/secret-store'
import { startMockAnthropic, type MockAnthropic, type MockTurn } from '../../scripts/mock-anthropic'

interface Body {
  system?: unknown
  tools?: unknown[]
  messages?: { role: string; content: string | { type: string; content?: unknown }[] }[]
}

const hasToolResult = (body: unknown): boolean =>
  ((body as Body).messages ?? []).some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
  )

/** Requests of the auto-mode classifier (a separate model call without tools). */
const isClassifier = (body: unknown): boolean =>
  JSON.stringify((body as Body).system ?? '').includes('security monitor')

const sandbox = sandboxStatus()

describe('work folder confinement of the coding chat (real runtime, scripted model)', () => {
  let mock: MockAnthropic
  let dir: string
  let outside: string
  let db: ReturnType<typeof openDatabase>
  let chats: ChatRepository
  let manager: SessionManager
  let nextTool: MockTurn['toolUse']
  let decision: PermissionDecision = 'allow'
  const events: AgentEvent[] = []
  const settings: Settings = { ...DEFAULT_SETTINGS }
  const originalHome = process.env['HOME']

  beforeAll(async () => {
    mock = await startMockAnthropic((body) =>
      isClassifier(body) || hasToolResult(body) || !nextTool
        ? { text: 'Fertig.' }
        : { text: 'Los geht es.', toolUse: nextTool },
    )
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'aiw-confine-')))
    // The sandbox hides the home directory; use a throwaway one with a "private" folder.
    process.env['HOME'] = join(dir, 'home')
    outside = join(dir, 'home', 'geheim')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'GEHEIM-AUSSERHALB')
    db = openDatabase(join(dir, 'w.db'))
    chats = new ChatRepository(db)
    Object.assign(settings, {
      activeProvider: 'ollama',
      ollamaBaseUrl: mock.url,
      models: { ...DEFAULT_SETTINGS.models, ollama: 'mock-model' },
    } satisfies Partial<Settings>)
    expect(settings.confineToWorkFolder).toBe(true)
    manager = new SessionManager({
      getSettings: () => settings,
      secrets: new SecretStore(join(dir, 's.json'), {
        isAvailable: () => true,
        encrypt: (s) => Buffer.from(s),
        decrypt: (b) => b.toString(),
      }),
      chats,
      dataDir: join(dir, 'data'),
      appVersion: 'test',
      executablePath: resolveClaudeExecutable(),
      emit: (event) => {
        events.push(event)
        if (event.type === 'permission-request') {
          manager.respondToPermission(event.requestId, decision)
        }
      },
    })
  })

  afterAll(async () => {
    if (originalHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = originalHome
    await mock.close()
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  async function run(name: string, mode: AgentPermissionMode, tool: MockTurn['toolUse']) {
    const projectDir = join(dir, name)
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'innen.txt'), 'HALLO-INNEN')
    const chat = manager.createProjectChat({ projectPath: projectDir })
    await manager.setPermissionMode(chat.id, mode)
    nextTool = tool
    events.length = 0
    expect(manager.send({ chatId: chat.id, prompt: 'Los', attachments: [] })).toBe(true)
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!manager.isRunning(chat.id)) {
          clearInterval(timer)
          resolve()
        }
      }, 50)
    })
    const ofChat = events.filter((e) => e.chatId === chat.id)
    const error = ofChat.find((e) => e.type === 'error')
    if (error) throw new Error(`Agent-Fehler: ${JSON.stringify(error)}`)
    const result = ofChat.find((e) => e.type === 'tool-result')
    return {
      project: projectDir,
      events: ofChat,
      asked: ofChat.some((e) => e.type === 'permission-request'),
      result: result?.type === 'tool-result' ? result : undefined,
    }
  }

  it('denies reading a file outside the project, even in "Alles erlauben"', async () => {
    const { result, asked } = await run('lesen-aussen', 'bypassPermissions', {
      name: 'Read',
      input: { file_path: join(outside, 'secret.txt') },
    })
    expect(asked).toBe(false)
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('Von AI Workbench blockiert')
    expect(result?.content).not.toContain('GEHEIM-AUSSERHALB')
  }, 120_000)

  it('denies writing outside via .. traversal', async () => {
    const { result } = await run('schreiben-aussen', 'bypassPermissions', {
      name: 'Write',
      input: { file_path: join(dir, 'schreiben-aussen', '..', 'geheim', 'neu.txt'), content: 'x' },
    })
    expect(result?.isError).toBe(true)
    expect(existsSync(join(outside, 'neu.txt'))).toBe(false)
  }, 120_000)

  it('reads a file inside the project', async () => {
    const { result } = await run('lesen-innen', 'default', {
      name: 'Read',
      input: { file_path: join(dir, 'lesen-innen', 'innen.txt') },
    })
    expect(result?.isError).toBe(false)
    expect(result?.content).toContain('HALLO-INNEN')
  }, 120_000)

  it('runs a test command with Bash after approval', async () => {
    decision = 'allow'
    const { result, asked } = await run('befehl', 'default', {
      name: 'Bash',
      input: { command: 'node -e "console.log(40 + 2)"', description: 'Test ausführen' },
    })
    expect(asked).toBe(true)
    expect(result?.isError).toBe(false)
    expect(result?.content).toContain('42')
  }, 120_000)

  it('asks before changing .mcp.json, which runs commands outside the sandbox', async () => {
    decision = 'deny'
    const { project, asked } = await run('geschuetzt', 'acceptEdits', {
      name: 'Write',
      input: { file_path: join(dir, 'geschuetzt', '.mcp.json'), content: '{}' },
    })
    expect(asked).toBe(true)
    expect(existsSync(join(project, '.mcp.json'))).toBe(false)
    decision = 'allow'
  }, 120_000)

  it('refuses changing .mcp.json in "Alles erlauben" (an "ask" would pass unseen)', async () => {
    const { project, asked, result } = await run('geschuetzt-bypass', 'bypassPermissions', {
      name: 'Write',
      input: { file_path: join(dir, 'geschuetzt-bypass', '.mcp.json'), content: '{}' },
    })
    expect(asked).toBe(false)
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('Alles erlauben')
    expect(existsSync(join(project, '.mcp.json'))).toBe(false)
  }, 120_000)

  it.runIf(sandbox.active)(
    'keeps Bash in the sandbox: home hidden, no writes outside the project',
    async () => {
      const elsewhere = join(dir, 'woanders.txt')
      const { result } = await run('sandbox', 'bypassPermissions', {
        name: 'Bash',
        input: {
          command:
            `cat ${join(outside, 'secret.txt')}; echo x > ${elsewhere}; ` +
            'echo "KEY=[$ANTHROPIC_AUTH_TOKEN]"; cat innen.txt; echo neu > neu.txt',
          description: 'Sandbox prüfen',
        },
      })
      expect(result?.content).not.toContain('GEHEIM-AUSSERHALB')
      expect(existsSync(elsewhere)).toBe(false)
      // API keys are removed from the environment of commands.
      expect(result?.content).toContain('KEY=[]')
      expect(result?.content).toContain('HALLO-INNEN')
      expect(existsSync(join(dir, 'sandbox', 'neu.txt'))).toBe(true)
    },
    120_000,
  )

  it.skipIf(sandbox.active)('reports honestly that Bash is not sandboxed here', () => {
    console.warn(`[confinement] OS-Sandbox nicht verfügbar: ${sandbox.summary}`)
    expect(sandbox.summary).toMatch(/NICHT auf den Arbeitsordner beschränkt/)
  })

  it('uses "Dateiänderungen erlauben" for auto mode with Ollama', async () => {
    decision = 'deny'
    const { project, asked, result } = await run('auto-ollama', 'auto', {
      name: 'Write',
      input: { file_path: join(dir, 'auto-ollama', 'auto.txt'), content: 'auto' },
    })
    expect(asked).toBe(false)
    expect(result?.isError).toBe(false)
    expect(existsSync(join(project, 'auto.txt'))).toBe(true)
    // The classifier was never asked (it would need a Claude model).
    decision = 'allow'
  }, 120_000)
})

/**
 * What auto mode needs, checked against the bundled runtime with the mock as the endpoint: every
 * action that is not a plain in-folder edit is sent to a classifier model (claude-sonnet-5 on the
 * configured endpoint, overridable with ANTHROPIC_DEFAULT_SONNET_MODEL). Without a usable answer
 * the action is blocked (fail closed).
 */
describe('auto permission mode of the runtime', () => {
  let dir: string

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'aiw-auto-')))
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))

  async function autoRun(classifier: (body: unknown) => string, sonnetModel?: string) {
    const classifierModels: string[] = []
    const mock = await startMockAnthropic((body) => {
      if (isClassifier(body)) {
        classifierModels.push((body as { model?: string }).model ?? '')
        return classifier(body)
      }
      return hasToolResult(body)
        ? { text: 'Fertig.' }
        : {
            text: 'Ich teste.',
            toolUse: {
              name: 'Bash',
              input: { command: 'node -e "console.log(6 * 7)"', description: 'Test' },
            },
          }
    })
    try {
      const project = mkdtempSync(join(dir, 'p-'))
      const runtime = buildProviderRuntime({
        provider: 'ollama',
        settings: {
          ...DEFAULT_SETTINGS,
          ollamaBaseUrl: mock.url,
          models: { ...DEFAULT_SETTINGS.models, ollama: 'mock-model' },
        },
        secret: undefined,
        baseEnv: process.env,
        configDir: join(project, '.cfg'),
        appVersion: 'test',
      })
      if (sonnetModel) runtime.env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = sonnetModel
      let output = ''
      let isError = false
      for await (const message of query({
        prompt: 'Los',
        options: {
          cwd: project,
          env: runtime.env,
          model: 'mock-model',
          pathToClaudeCodeExecutable: resolveClaudeExecutable(),
          permissionMode: 'auto',
          persistSession: false,
          tools: ['Bash'],
        },
      })) {
        if (message.type !== 'user' || !Array.isArray(message.message.content)) continue
        for (const block of message.message.content) {
          if (block.type === 'tool_result') {
            output += JSON.stringify(block.content)
            isError ||= block.is_error === true
          }
        }
      }
      return { output, isError, classifierModels }
    } finally {
      await mock.close()
    }
  }

  it('runs a command once a Claude classifier answers', async () => {
    // Stage 1 asks for a severity, stage 2 for a block decision.
    const { output, isError, classifierModels } = await autoRun((body) =>
      JSON.stringify(body).includes('<severity>N<') ? '<severity>1' : '<block>no</block>',
    )
    expect(classifierModels.length).toBeGreaterThan(0)
    expect(new Set(classifierModels)).toEqual(new Set(['claude-sonnet-5']))
    expect(isError).toBe(false)
    expect(output).toContain('42')
  }, 120_000)

  it('blocks the command when no classifier model answers (as with Ollama)', async () => {
    const { output, isError } = await autoRun(() => 'Modell nicht gefunden')
    expect(isError).toBe(true)
    expect(output).toMatch(/Auto mode could not evaluate/)
  }, 180_000)

  it('sends the classifier to the model set for "sonnet" (used for OpenRouter)', async () => {
    const { classifierModels } = await autoRun(
      (body) =>
        JSON.stringify(body).includes('<severity>N<') ? '<severity>1' : '<block>no</block>',
      'anthropic/claude-sonnet-5',
    )
    expect(new Set(classifierModels)).toEqual(new Set(['anthropic/claude-sonnet-5']))
  }, 120_000)
})
