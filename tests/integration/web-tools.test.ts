import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { createWebMcpServer } from '../../src/main/web/mcp-server'
import { WebClient } from '../../src/main/web/web-client'
import { startMockAnthropic, type MockAnthropic } from '../../scripts/mock-anthropic'

interface Body {
  messages?: { role: string; content: string | { type: string; content?: unknown }[] }[]
  tools?: { name: string }[]
}

describe('web tools inside the agent (real runtime, offline fixtures)', () => {
  let mock: MockAnthropic
  let dir: string
  let chats: ChatRepository
  let db: ReturnType<typeof openDatabase>
  const events: AgentEvent[] = []
  let toolNamesSeen: string[] = []

  beforeAll(async () => {
    mock = await startMockAnthropic((raw) => {
      const body = raw as Body
      toolNamesSeen = (body.tools ?? []).map((t) => t.name)
      const done = (body.messages ?? []).some(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
      )
      return done
        ? { text: 'Laut Suche ist Electron ein Framework.' }
        : { toolUse: { name: 'mcp__web__web_search', input: { query: 'electron framework' } } }
    })
    dir = mkdtempSync(join(tmpdir(), 'aiw-web-'))
    db = openDatabase(join(dir, 'w.db'))
    chats = new ChatRepository(db)
  })

  afterAll(async () => {
    await mock.close()
    // Windows keeps open SQLite files locked, so close before deleting.
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('lets the chat agent search the web without asking and returns sources', async () => {
    const bing = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'bing.html'), 'utf8')
    const web = new WebClient({
      // Offline: the first provider "fails", Bing answers from the captured page.
      searchLoader: async (url) => ({
        status: url.includes('bing.com') ? 200 : 503,
        finalUrl: url,
        body: url.includes('bing.com') ? bing : '',
        contentType: 'text/html',
      }),
      pageLoader: async (url) => ({
        status: 404,
        finalUrl: url,
        body: '',
        contentType: 'text/html',
      }),
      sleep: async () => undefined,
    })
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      activeProvider: 'ollama',
      ollamaBaseUrl: mock.url,
      models: { ...DEFAULT_SETTINGS.models, ollama: 'mock-model' },
    }
    const manager = new SessionManager({
      getSettings: () => settings,
      secrets: new SecretStore(join(dir, 's.json'), {
        isAvailable: () => true,
        encrypt: (s) => Buffer.from(s),
        decrypt: (b) => b.toString(),
      }),
      chats,
      dataDir: dir,
      appVersion: 'test',
      executablePath: resolveClaudeExecutable(),
      emit: (e) => events.push(e),
      createWebServer: () => createWebMcpServer(web),
    })

    manager.send({ chatId: 'w1', prompt: 'Was ist Electron?', attachments: [] })
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!manager.isRunning('w1')) {
          clearInterval(timer)
          resolve()
        }
      }, 50)
    })

    expect(toolNamesSeen).toContain('mcp__web__web_search')
    // Built-in web tools are replaced by ours.
    expect(toolNamesSeen).not.toContain('WebSearch')
    expect(events.some((e) => e.type === 'permission-request')).toBe(false)
    const result = events.find((e) => e.type === 'tool-result')
    expect(result).toMatchObject({ isError: false })
    expect(result && 'content' in result ? result.content : '').toContain(
      'https://github.com/electron/electron',
    )
    const reply = chats.get('w1')?.messages.at(-1)
    expect(reply?.parts.map((p) => p.type)).toEqual(['tool', 'text'])
    expect(reply?.error).toBeNull()
  }, 120_000)
})
