import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/schemas/settings'
import type { AgentEvent } from '@shared/schemas/agent'
import { chatAttachmentsDir, SessionManager } from '../../src/main/agent/session-manager'
import { resolveClaudeExecutable } from '../../src/main/agent/executable'
import { ChatRepository } from '../../src/main/storage/chat-repository'
import { openDatabase } from '../../src/main/storage/database'
import { SecretStore } from '../../src/main/storage/secret-store'
import { storeAttachment } from '../../src/main/workspace/attachments'
import { startMockAnthropic, type MockAnthropic } from '../../scripts/mock-anthropic'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

interface MessagesBody {
  messages?: { role: string; content: string | { type: string }[] }[]
}

/** Reports what the mock saw, so assertions can check what reached the "API". */
function describeRequest(body: unknown): string {
  // The runtime may add its own non-user context messages, so only count user turns.
  const userMessages = ((body as MessagesBody).messages ?? []).filter((m) => m.role === 'user')
  const blocks = userMessages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
  const images = blocks.filter((b) => b.type === 'image').length
  return `Antwort #${userMessages.length} (Bilder: ${images})`
}

describe('SessionManager with the real runtime', () => {
  let mock: MockAnthropic
  let dir: string
  let chats: ChatRepository
  let manager: SessionManager
  const events: AgentEvent[] = []

  beforeAll(async () => {
    mock = await startMockAnthropic(describeRequest)
    dir = mkdtempSync(join(tmpdir(), 'aiw-sm-'))
    chats = new ChatRepository(openDatabase(join(dir, 'w.db')))
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
      dataDir: dir,
      appVersion: 'test',
      executablePath: resolveClaudeExecutable(),
      emit: (e) => events.push(e),
    })
  })

  afterAll(async () => {
    await mock.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function waitForDone(chatId: string): Promise<void> {
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (
          events.some((e) => e.chatId === chatId && e.type === 'done') &&
          !manager.isRunning(chatId)
        ) {
          clearInterval(timer)
          resolve()
        }
      }, 50)
    })
  }

  it('sends images to the model, persists the chat and resumes the conversation', async () => {
    const chatId = 'chat-1'
    const image = storeAttachment(
      { source: 'data', name: 'pixel.png', mimeType: 'image/png', base64: PNG_BASE64 },
      chatAttachmentsDir(dir, chatId),
    )

    expect(manager.send({ chatId, prompt: 'Was ist auf dem Bild?', attachments: [image] })).toBe(
      true,
    )
    // A second send while busy is rejected.
    expect(manager.send({ chatId, prompt: 'noch was', attachments: [] })).toBe(false)
    await waitForDone(chatId)

    let chat = chats.get(chatId)
    expect(chat?.title).toBe('Was ist auf dem Bild?')
    expect(chat?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(chat?.messages[0]?.attachments[0]?.name).toBe('pixel.png')
    expect(chat?.messages[1]?.text).toBe('Antwort #1 (Bilder: 1)')
    expect(chat?.messages[1]?.error).toBeNull()
    expect(chats.getSdkSessionId(chatId)).toBeTruthy()

    // Follow-up: the runtime resumes the session, so the API sees the earlier turns too.
    events.length = 0
    expect(manager.send({ chatId, prompt: 'Und jetzt?', attachments: [] })).toBe(true)
    await waitForDone(chatId)
    chat = chats.get(chatId)
    expect(chat?.messages).toHaveLength(4)
    expect(chat?.messages[3]?.text).toBe('Antwort #2 (Bilder: 1)')
  }, 120_000)

  it('ignores attachments that point outside the chat folder', async () => {
    const chatId = 'chat-2'
    const outside = storeAttachment(
      { source: 'data', name: 'x.png', mimeType: 'image/png', base64: PNG_BASE64 },
      join(dir, 'elsewhere'),
    )
    expect(manager.send({ chatId, prompt: 'Hallo', attachments: [outside] })).toBe(true)
    await waitForDone(chatId)
    const chat = chats.get(chatId)
    expect(chat?.messages[0]?.attachments).toEqual([])
    expect(chat?.messages[1]?.text).toBe('Antwort #1 (Bilder: 0)')
  }, 120_000)

  it('reports a missing model as an error and still saves the turn', async () => {
    const chatId = 'chat-3'
    const failing = new SessionManager({
      getSettings: () => ({ ...DEFAULT_SETTINGS, activeProvider: 'openrouter' }),
      secrets: new SecretStore(join(dir, 's2.json'), {
        isAvailable: () => true,
        encrypt: (s) => Buffer.from(s),
        decrypt: (b) => b.toString(),
      }),
      chats,
      dataDir: dir,
      appVersion: 'test',
      executablePath: resolveClaudeExecutable(),
      emit: (e) => events.push(e),
    })
    failing.send({ chatId, prompt: 'Hallo', attachments: [] })
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!failing.isRunning(chatId)) {
          clearInterval(timer)
          resolve()
        }
      }, 20)
    })
    const errorEvent = events.find((e) => e.chatId === chatId && e.type === 'error')
    expect(errorEvent).toMatchObject({ message: expect.stringContaining('API-Key') })
    expect(chats.get(chatId)?.messages[1]?.error).toContain('API-Key')
  })
})
