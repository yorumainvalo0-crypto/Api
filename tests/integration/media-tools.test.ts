import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { listOutputs, outputsDir } from '../../src/main/media/outputs'
import { startMockAnthropic, type MockAnthropic } from '../../scripts/mock-anthropic'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const CUBE_OBJ = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n'

interface Body {
  messages?: { role: string; content: string | { type: string }[] }[]
}

describe('media tools inside the agent (real runtime)', () => {
  let mock: MockAnthropic
  let dir: string
  let db: ReturnType<typeof openDatabase>
  let chats: ChatRepository
  const events: AgentEvent[] = []
  const openRouterBodies: unknown[] = []

  beforeAll(async () => {
    // Turn 1: generate an image, turn 2: save a 3D model, turn 3: answer.
    mock = await startMockAnthropic((raw) => {
      const results = ((raw as Body).messages ?? []).flatMap((m) =>
        Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : [],
      ).length
      if (results === 0) {
        return {
          toolUse: {
            name: 'mcp__media__generate_image',
            input: { prompt: 'Ein roter Würfel', file_name: 'wuerfel' },
          },
        }
      }
      if (results === 1) {
        return {
          toolUse: {
            name: 'mcp__media__save_file',
            input: { file_name: 'wuerfel.obj', content: CUBE_OBJ },
          },
        }
      }
      return { text: 'Bild und Modell sind fertig.' }
    })
    dir = mkdtempSync(join(tmpdir(), 'aiw-media-'))
    db = openDatabase(join(dir, 'w.db'))
    chats = new ChatRepository(db)
  })

  afterAll(async () => {
    await mock.close()
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('generates an image and a 3D model, shows them inline and lists them as outputs', async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      activeProvider: 'ollama',
      ollamaBaseUrl: mock.url,
      models: { ...DEFAULT_SETTINGS.models, ollama: 'mock-model' },
      imageModel: 'test/image-model',
      webAccess: false,
    }
    const secrets = new SecretStore(join(dir, 's.json'), {
      isAvailable: () => true,
      encrypt: (s) => Buffer.from(s),
      decrypt: (b) => b.toString(),
    })
    secrets.set('openrouter', 'sk-or-test')
    const manager = new SessionManager({
      getSettings: () => settings,
      secrets,
      chats,
      dataDir: dir,
      appVersion: 'test',
      executablePath: resolveClaudeExecutable(),
      emit: (e) => events.push(e),
      // Fake OpenRouter image endpoint.
      mediaFetch: (async (_url: string, init?: RequestInit) => {
        openRouterBodies.push(JSON.parse(String(init?.body)))
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '',
                  images: [
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
                  ],
                },
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      }) as typeof fetch,
    })

    manager.send({ chatId: 'm1', prompt: 'Mach mir einen Würfel', attachments: [] })
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!manager.isRunning('m1')) {
          clearInterval(timer)
          resolve()
        }
      }, 50)
    })

    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(openRouterBodies[0]).toMatchObject({ model: 'test/image-model' })
    const files = events.flatMap((e) => (e.type === 'output-file' ? [e.file] : []))
    expect(files.map((f) => [f.name, f.kind])).toEqual([
      ['wuerfel.png', 'image'],
      ['wuerfel.obj', 'model3d'],
    ])
    expect(files.every((f) => existsSync(f.path))).toBe(true)
    expect(readFileSync(files[1]?.path ?? '', 'utf8')).toBe(CUBE_OBJ)

    const chat = chats.summary('m1')
    if (!chat) throw new Error('chat missing')
    expect(
      listOutputs(outputsDir(dir, chat))
        .map((f) => f.name)
        .sort(),
    ).toEqual(['wuerfel.obj', 'wuerfel.png'])
    const parts = chats
      .get('m1')
      ?.messages.at(-1)
      ?.parts.map((p) => p.type)
    expect(parts).toEqual(['tool', 'file', 'tool', 'file', 'text'])
  }, 120_000)
})
