import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/schemas/settings'
import type { AgentEvent } from '@shared/schemas/agent'
import { SessionManager } from '../../src/main/agent/session-manager'
import { resolveClaudeExecutable } from '../../src/main/agent/executable'
import { ChatRepository } from '../../src/main/storage/chat-repository'
import { openDatabase } from '../../src/main/storage/database'
import { SecretStore, type Cipher } from '../../src/main/storage/secret-store'
import { AddonStore } from '../../src/main/addons/addon-store'
import { extractArchive, findCandidates } from '../../src/main/addons/github-archive'
import { startMockAnthropic, type MockAnthropic } from '../../scripts/mock-anthropic'

interface Body {
  messages?: { role: string; content: string | { type: string }[] }[]
  tools?: { name: string; description?: string }[]
}

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(s),
  decrypt: (b) => b.toString(),
}

describe('installed add-ons inside the agent (real runtime)', () => {
  let mock: MockAnthropic
  let dir: string
  let db: ReturnType<typeof openDatabase>
  let lastBody: Body = {}

  beforeAll(async () => {
    mock = await startMockAnthropic((raw) => {
      lastBody = raw as Body
      const done = (lastBody.messages ?? []).some(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
      )
      return done
        ? { text: 'Erledigt.' }
        : { toolUse: { name: 'mcp__echo__echo', input: { text: 'hallo' } } }
    })
    dir = mkdtempSync(join(tmpdir(), 'aiw-addon-int-'))
    db = openDatabase(join(dir, 'w.db'))
  })

  afterAll(async () => {
    await mock.close()
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('offers installed skills and asks before using tools of a user MCP server', async () => {
    const addons = new AddonStore(
      {
        skillsDir: join(dir, 'agent-config', 'skills'),
        pluginsDir: join(dir, 'addons', 'plugins'),
        stateFile: join(dir, 'addons', 'addons.json'),
      },
      cipher,
    )
    // Skill from a (fake) GitHub archive.
    const files = extractArchive(
      zipSync({
        'repo-main/skills/rezepte/SKILL.md': strToU8(
          '---\nname: rezepte\ndescription: Kocht Rezepte nach ZEBRA-Methode\n---\n# Rezepte',
        ),
      }),
    )
    const [skill] = findCandidates(files)
    if (!skill) throw new Error('skill missing')
    addons.installFromRepo(files, skill)
    // A real stdio MCP server with an encrypted secret.
    addons.saveMcpServer({
      name: 'echo',
      enabled: true,
      description: 'Test',
      source: 'manual',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [join(import.meta.dirname, '..', 'fixtures', 'echo-mcp-server.mjs')],
        env: { ECHO_SECRET: 's3cret' },
      },
    })

    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      activeProvider: 'ollama',
      ollamaBaseUrl: mock.url,
      models: { ...DEFAULT_SETTINGS.models, ollama: 'mock-model' },
      webAccess: false,
    }
    const events: AgentEvent[] = []
    const chats = new ChatRepository(db)
    const manager = new SessionManager({
      getSettings: () => settings,
      secrets: new SecretStore(join(dir, 's.json'), cipher),
      chats,
      dataDir: dir,
      appVersion: 'test',
      executablePath: resolveClaudeExecutable(),
      getAddons: () => addons.agentConfig(),
      emit: (e) => {
        events.push(e)
        if (e.type === 'permission-request') manager.respondToPermission(e.requestId, 'allow')
      },
    })

    manager.send({ chatId: 'a1', prompt: 'Nutze echo', attachments: [] })
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!manager.isRunning('a1')) {
          clearInterval(timer)
          resolve()
        }
      }, 50)
    })

    const toolNames = (lastBody.tools ?? []).map((t) => t.name)
    expect(toolNames).toContain('Skill')
    expect(JSON.stringify(lastBody)).toContain('ZEBRA-Methode')
    expect(toolNames).toContain('mcp__echo__echo')

    const request = events.find((e) => e.type === 'permission-request')
    expect(request).toMatchObject({ toolName: 'mcp__echo__echo' })
    const result = events.find((e) => e.type === 'tool-result')
    expect(result).toMatchObject({ isError: false, content: 'ECHO:hallo:s3cret' })
    expect(events.some((e) => e.type === 'error')).toBe(false)
  }, 120_000)
})
