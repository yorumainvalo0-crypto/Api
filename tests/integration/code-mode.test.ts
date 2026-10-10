import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/schemas/settings'
import type { AgentEvent, PermissionDecision } from '@shared/schemas/agent'
import type { AgentPermissionMode } from '@shared/schemas/chat'
import { SessionManager } from '../../src/main/agent/session-manager'
import { resolveClaudeExecutable } from '../../src/main/agent/executable'
import { ChatRepository } from '../../src/main/storage/chat-repository'
import { openDatabase } from '../../src/main/storage/database'
import { SecretStore } from '../../src/main/storage/secret-store'
import { startMockAnthropic, type MockAnthropic, type MockTurn } from '../../scripts/mock-anthropic'

interface Body {
  messages?: { role: string; content: string | { type: string; content?: unknown }[] }[]
}

/** True once the conversation contains a tool result, i.e. the tool already ran. */
function hasToolResult(body: unknown): boolean {
  return ((body as Body).messages ?? []).some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
  )
}

describe('coding agent (real runtime, scripted model)', () => {
  let mock: MockAnthropic
  let dir: string
  let chats: ChatRepository
  let db: ReturnType<typeof openDatabase>
  let manager: SessionManager
  /** The tool call the scripted model makes on its first turn. */
  let nextTool: MockTurn['toolUse']
  /** How the test "user" answers permission prompts. */
  let decision: PermissionDecision = 'allow'
  const events: AgentEvent[] = []
  const systemPrompts: string[] = []

  beforeAll(async () => {
    mock = await startMockAnthropic((body) => {
      systemPrompts.push(JSON.stringify((body as { system?: unknown }).system ?? ''))
      return hasToolResult(body) || !nextTool
        ? { text: 'Fertig.' }
        : { text: 'Ich lege die Datei an.', toolUse: nextTool }
    })
    dir = mkdtempSync(join(tmpdir(), 'aiw-code-'))
    db = openDatabase(join(dir, 'w.db'))
    chats = new ChatRepository(db)
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      activeProvider: 'ollama',
      ollamaBaseUrl: mock.url,
      models: { ...DEFAULT_SETTINGS.models, ollama: 'mock-model' },
    }
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
    await mock.close()
    // Windows keeps open SQLite files locked, so close before deleting.
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  async function run(name: string, mode: AgentPermissionMode, tool: MockTurn['toolUse']) {
    mkdirSync(join(dir, name), { recursive: true })
    const chat = manager.createProjectChat({ projectPath: join(dir, name) })
    const project = chat.projectPath ?? ''
    await manager.setPermissionMode(chat.id, mode)
    nextTool =
      typeof tool?.input['file_path'] === 'string'
        ? {
            ...tool,
            input: { ...tool.input, file_path: join(project, String(tool.input['file_path'])) },
          }
        : tool
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
    return { project, chatId: chat.id, events: ofChat }
  }

  it('gives non-Claude models the open-source coding prompt', async () => {
    await run('prompt', 'default', undefined)
    expect(systemPrompts.some((p) => p.includes('You are a coding agent'))).toBe(true)
    expect(systemPrompts.some((p) => p.includes('Was die AI Workbench kann'))).toBe(true)
  }, 120_000)

  it('asks for permission, writes the file after approval and persists the tool call', async () => {
    decision = 'allow'
    const {
      project,
      chatId,
      events: ev,
    } = await run('allow', 'default', {
      name: 'Write',
      input: { file_path: 'hallo.txt', content: 'Hallo Welt' },
    })
    expect(ev.some((e) => e.type === 'permission-request')).toBe(true)
    expect(ev.some((e) => e.type === 'permission-resolved')).toBe(true)
    expect(readFileSync(join(project, 'hallo.txt'), 'utf8')).toBe('Hallo Welt')

    const reply = chats.get(chatId)?.messages.at(-1)
    expect(reply?.parts.map((p) => p.type)).toEqual(['text', 'tool', 'text'])
    const tool = reply?.parts.find((p) => p.type === 'tool')
    expect(tool).toMatchObject({ call: { name: 'Write', isError: false } })
    expect(reply?.error).toBeNull()
  }, 120_000)

  it('does not write anything when the user denies', async () => {
    decision = 'deny'
    const { project, events: ev } = await run('deny', 'default', {
      name: 'Write',
      input: { file_path: 'nein.txt', content: 'x' },
    })
    expect(ev.some((e) => e.type === 'permission-request')).toBe(true)
    expect(existsSync(join(project, 'nein.txt'))).toBe(false)
    expect(ev.find((e) => e.type === 'tool-result')).toMatchObject({ isError: true })
  }, 120_000)

  it('writes without asking in "Dateiänderungen erlauben" mode', async () => {
    decision = 'deny'
    const { project, events: ev } = await run('accept', 'acceptEdits', {
      name: 'Write',
      input: { file_path: 'auto.txt', content: 'auto' },
    })
    expect(ev.some((e) => e.type === 'permission-request')).toBe(false)
    expect(readFileSync(join(project, 'auto.txt'), 'utf8')).toBe('auto')
  }, 120_000)

  it('blocks dangerous shell commands even in "Alles erlauben" mode', async () => {
    decision = 'allow'
    const { events: ev } = await run('danger', 'bypassPermissions', {
      name: 'Bash',
      input: { command: 'rm -rf / --no-preserve-root', description: 'cleanup' },
    })
    expect(ev.some((e) => e.type === 'permission-request')).toBe(false)
    const result = ev.find((e) => e.type === 'tool-result')
    expect(result).toMatchObject({ isError: true })
    expect(result && 'content' in result ? result.content : '').toContain('blockiert')
  }, 120_000)
})
