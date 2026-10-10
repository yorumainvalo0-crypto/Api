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
import { ComfyWorkflowStore } from '../../src/main/media/comfy-workflows'
import { startMockAnthropic, type MockAnthropic } from '../../scripts/mock-anthropic'
import { startMockComfy, type MockComfy } from '../../scripts/mock-comfy'

const HUNYUAN_3D = JSON.stringify({
  '1': { class_type: 'LoadImage', inputs: { image: '{{input_image}}' } },
  '9': { class_type: 'SaveGLB', inputs: { mesh: ['1', 0], filename_prefix: 'mesh/3d' } },
})

describe('local ComfyUI generation inside the agent (real runtime)', () => {
  let anthropic: MockAnthropic
  let comfy: MockComfy
  let dir: string
  let db: ReturnType<typeof openDatabase>
  let toolNames: string[] = []

  beforeAll(async () => {
    comfy = await startMockComfy()
    // Turn 1: image; turn 2: 3D model from that image; turn 3: answer.
    anthropic = await startMockAnthropic((raw) => {
      const body = raw as { tools?: { name: string }[]; messages?: unknown[] }
      toolNames = (body.tools ?? []).map((t) => t.name)
      const text = JSON.stringify(body.messages ?? [])
      const results = (text.match(/"tool_result"/g) ?? []).length
      if (results === 0) {
        return {
          toolUse: {
            name: 'mcp__media__generate_image',
            input: { prompt: 'Stuhl', file_name: 'stuhl' },
          },
        }
      }
      if (results === 1) {
        // Read the saved path from the tool result text (Windows paths contain backslashes).
        const resultText = ((body.messages ?? []) as { content?: unknown }[])
          .flatMap((m) =>
            Array.isArray(m.content) ? (m.content as { type?: string; content?: unknown }[]) : [],
          )
          .filter((b) => b.type === 'tool_result')
          .map((b) => JSON.stringify(b.content))
          .join('\n')
        const encoded = /- (.+?stuhl\.png)/.exec(resultText)?.[1] ?? ''
        const path = JSON.parse(`"${encoded}"`) as string
        return {
          toolUse: {
            name: 'mcp__media__generate_3d_model',
            input: { prompt: 'Stuhl', input_image_path: path, file_name: 'stuhl' },
          },
        }
      }
      return { text: 'Bild und 3D-Modell sind fertig.' }
    })
    dir = mkdtempSync(join(tmpdir(), 'aiw-comfy-agent-'))
    db = openDatabase(join(dir, 'w.db'))
  })

  afterAll(async () => {
    await anthropic.close()
    await comfy.close()
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('creates an image and a GLB model locally without any cloud key', async () => {
    const workflows = new ComfyWorkflowStore(join(dir, 'comfy'))
    workflows.import('Hunyuan3D', '3d', HUNYUAN_3D)
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      activeProvider: 'ollama',
      ollamaBaseUrl: anthropic.url,
      models: { ...DEFAULT_SETTINGS.models, ollama: 'mock-model' },
      webAccess: false,
      imageBackend: 'comfyui',
      comfyUrl: comfy.url,
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
      comfyWorkflows: workflows,
      comfyFetch: fetch,
      emit: (e) => events.push(e),
    })

    manager.send({ chatId: 'c1', prompt: 'Bitte Stuhl als Bild und 3D', attachments: [] })
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!manager.isRunning('c1')) {
          clearInterval(timer)
          resolve()
        }
      }, 50)
    })

    expect(toolNames).toContain('mcp__media__generate_3d_model')
    expect(
      events.filter((e) => e.type === 'tool-result').map((e) => 'isError' in e && e.isError),
    ).toEqual([false, false])
    const files = events.flatMap((e) => (e.type === 'output-file' ? [e.file] : []))
    expect(files.map((f) => [f.name, f.kind])).toEqual([
      ['stuhl.png', 'image'],
      ['stuhl.glb', 'model3d'],
    ])
    expect(files.every((f) => existsSync(f.path))).toBe(true)
    expect(
      readFileSync(files[1]?.path ?? '')
        .subarray(0, 4)
        .toString(),
    ).toBe('glTF')
    // The generated image was uploaded to ComfyUI as input for the 3D workflow.
    expect(comfy.uploads).toEqual(['stuhl.png'])
  }, 120_000)
})
