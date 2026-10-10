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
import { startMockOllama, type MockOllama } from '../../scripts/mock-ollama'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

describe('local handwriting OCR inside the agent (real runtime)', () => {
  let anthropic: MockAnthropic
  let ollama: MockOllama
  let dir: string
  let db: ReturnType<typeof openDatabase>
  let imagePath = ''
  let toolNames: string[] = []

  beforeAll(async () => {
    ollama = await startMockOllama('Einkaufsliste:\n- Milch\n- Brot')
    ollama.installed.add('qwen3-vl:8b-instruct')
    anthropic = await startMockAnthropic((raw) => {
      const body = raw as { tools?: { name: string }[]; messages?: unknown[] }
      toolNames = (body.tools ?? []).map((t) => t.name)
      const done = JSON.stringify(body.messages ?? []).includes('"tool_result"')
      return done
        ? { text: 'Auf dem Zettel steht eine Einkaufsliste.' }
        : { toolUse: { name: 'mcp__media__read_handwriting', input: { image_path: imagePath } } }
    })
    dir = mkdtempSync(join(tmpdir(), 'aiw-ocr-'))
    db = openDatabase(join(dir, 'w.db'))
  })

  afterAll(async () => {
    await anthropic.close()
    await ollama.close()
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('transcribes an attached handwritten note with the local vision model', async () => {
    const attachment = storeAttachment(
      { source: 'data', name: 'zettel.png', mimeType: 'image/png', base64: PNG },
      chatAttachmentsDir(dir, 'o1'),
    )
    imagePath = attachment.path
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      activeProvider: 'ollama',
      ollamaBaseUrl: anthropic.url,
      models: { ...DEFAULT_SETTINGS.models, ollama: 'mock-model' },
      webAccess: false,
      ocrEnabled: true,
      ocrBaseUrl: ollama.url,
      ocrKeepAliveSec: 0,
    }
    const events: AgentEvent[] = []
    const chats = new ChatRepository(db)
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
      ocrFetch: fetch,
      emit: (e) => events.push(e),
    })

    manager.send({ chatId: 'o1', prompt: 'Was steht auf dem Zettel?', attachments: [attachment] })
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!manager.isRunning('o1')) {
          clearInterval(timer)
          resolve()
        }
      }, 50)
    })

    expect(toolNames).toContain('mcp__media__read_handwriting')
    expect(events.some((e) => e.type === 'permission-request')).toBe(false)
    expect(events.find((e) => e.type === 'tool-result')).toMatchObject({
      isError: false,
      content: 'Einkaufsliste:\n- Milch\n- Brot',
    })
    // The model is unloaded from the GPU right after use (keep_alive 0s).
    expect(ollama.chats.at(-1)?.keep_alive).toBe('0s')
  }, 120_000)
})
