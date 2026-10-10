import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { DEFAULT_SETTINGS } from '@shared/schemas/settings'
import type { AgentEvent } from '@shared/schemas/agent'
import { buildProviderRuntime } from '../../src/main/agent/providers'
import { resolveClaudeExecutable } from '../../src/main/agent/executable'
import { normalizeSdkMessage, type SdkMessageLike } from '../../src/main/agent/normalize'
import { startMockAnthropic, type MockAnthropic } from '../../scripts/mock-anthropic'

/**
 * End-to-end spike: spawns the real Claude Code runtime through the Agent SDK and points it
 * at a local Anthropic-compatible mock, exactly like the Ollama/OpenRouter routes do.
 */
describe('Claude Agent SDK runtime', () => {
  let mock: MockAnthropic
  let dir: string

  beforeAll(async () => {
    mock = await startMockAnthropic('Hallo vom Mock-Server!')
    dir = mkdtempSync(join(tmpdir(), 'aiw-sdk-'))
  })

  afterAll(async () => {
    await mock.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('streams a reply through an Anthropic-compatible endpoint', async () => {
    const runtime = buildProviderRuntime({
      provider: 'ollama',
      settings: {
        ...DEFAULT_SETTINGS,
        ollamaBaseUrl: mock.url,
        models: { ...DEFAULT_SETTINGS.models, ollama: 'mock-model' },
      },
      secret: undefined,
      baseEnv: process.env,
      configDir: join(dir, 'config'),
      appVersion: 'test',
    })

    const events: AgentEvent[] = []
    for await (const message of query({
      prompt: 'Sag hallo',
      options: {
        cwd: dir,
        env: runtime.env,
        model: runtime.model ?? 'mock-model',
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        includePartialMessages: true,
        tools: [],
        settingSources: [],
        persistSession: false,
      },
    })) {
      events.push(...normalizeSdkMessage('s1', message as SdkMessageLike))
    }

    const streamed = events
      .filter((e): e is Extract<AgentEvent, { type: 'text-delta' }> => e.type === 'text-delta')
      .map((e) => e.text)
      .join('')
    const result = events.find((e) => e.type === 'result')

    expect(events.some((e) => e.type === 'init')).toBe(true)
    expect(streamed).toBe('Hallo vom Mock-Server!')
    expect(result).toMatchObject({ type: 'result', isError: false, text: 'Hallo vom Mock-Server!' })

    const messageCalls = mock.requests.filter((r) => r.path === '/v1/messages')
    expect(messageCalls.length).toBeGreaterThan(0)
    // The auth token from the provider runtime must reach the endpoint.
    expect(messageCalls.some((r) => r.headers['authorization'] === 'Bearer ollama')).toBe(true)
  }, 90_000)
})
