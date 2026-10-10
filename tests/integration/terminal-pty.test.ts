import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/schemas/settings'
import type { TerminalExitEvent } from '@shared/schemas/terminal'
import { resolveClaudeExecutable } from '../../src/main/agent/executable'
import { openDatabase } from '../../src/main/storage/database'
import { UsageRepository } from '../../src/main/storage/usage-repository'
import { TerminalService } from '../../src/main/terminal/service'
import { TERMINAL_SYSTEM_NOTE } from '../../src/main/terminal/wrapper'
import { startMockAnthropic, type MockAnthropic } from '../../scripts/mock-anthropic'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(${BEL}|${ESC}\\\\)`, 'g')
const CSI = new RegExp(`${ESC}\\[[0-9;?<>=]*[ -/]*[@-~]`, 'g')
const CHARSET = new RegExp(`${ESC}[()][0-9A-B]`, 'g')

/** Removes escape sequences and all whitespace (TUIs position text with cursor moves). */
function squash(text: string): string {
  return text.replace(OSC, '').replace(CSI, '').replace(CHARSET, '').replace(/\s+/g, '')
}

const randomId = () => crypto.randomUUID()

// Real PTYs with the bundled runtime; Windows is covered by the packaged smoke test in CI.
describe.skipIf(process.platform === 'win32')('terminal with a real PTY', () => {
  let mock: MockAnthropic
  let dir: string
  let db: ReturnType<typeof openDatabase>
  let usage: UsageRepository
  let service: TerminalService
  const output = new Map<string, string>()
  const exits: TerminalExitEvent[] = []
  const settings: Settings = { ...DEFAULT_SETTINGS }

  beforeAll(async () => {
    mock = await startMockAnthropic((body) =>
      JSON.stringify(body).includes('Zweite Frage') ? 'Antwort B' : 'Mock-Antwort 42',
    )
    dir = mkdtempSync(join(tmpdir(), 'aiw-term-'))
    db = openDatabase(join(dir, 'w.db'))
    usage = new UsageRepository(db)
    Object.assign(settings, {
      activeProvider: 'ollama',
      ollamaBaseUrl: mock.url,
      models: { ...DEFAULT_SETTINGS.models, ollama: 'mock-model' },
    })
    service = new TerminalService({
      dataDir: join(dir, 'data'),
      appVersion: 'test',
      claudeExecutable: resolveClaudeExecutable(),
      getSettings: () => settings,
      getSecret: () => undefined,
      usage,
      usageIdleMs: 60_000,
      // The app leaves effort out for Ollama; set it here to verify the runtime honours the variable.
      adjustEnv: (env) => {
        env['CLAUDE_CODE_EFFORT_LEVEL'] = 'low'
      },
      emitData: ({ sessionId, data }) =>
        output.set(sessionId, (output.get(sessionId) ?? '') + data),
      emitExit: (event) => exits.push(event),
    })
  })

  afterAll(async () => {
    await service.dispose()
    await mock.close()
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  async function waitFor(
    check: () => boolean,
    what: string,
    sessionId: string,
    timeoutMs = 30_000,
  ): Promise<void> {
    const started = Date.now()
    while (!check()) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timeout: ${what}\n${squash(output.get(sessionId) ?? '').slice(-1500)}`)
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  const screen = (sessionId: string, from = 0) => squash((output.get(sessionId) ?? '').slice(from))

  it('runs an interactive shell with input, resize and exit', async () => {
    const sessionId = randomId()
    const created = await service.create({ sessionId, cwd: dir, cols: 80, rows: 24 })
    expect(created.cwd).toBe(dir)
    expect(created.notice).toBeNull()
    // The quotes keep the marker out of the echoed input.
    service.write(sessionId, 'echo AIW-PTY""-OK\r')
    await waitFor(() => screen(sessionId).includes('AIW-PTY-OK'), 'echo output', sessionId)
    expect(service.resize(sessionId, 100, 30)).toBe(true)
    const mark = (output.get(sessionId) ?? '').length
    service.write(sessionId, 'stty size\r')
    await waitFor(() => screen(sessionId, mark).includes('30100'), 'new size', sessionId)
    service.write(sessionId, 'exit\r')
    await waitFor(() => exits.some((e) => e.sessionId === sessionId), 'exit event', sessionId)
    expect(exits.find((e) => e.sessionId === sessionId)?.exitCode).toBe(0)
    expect(service.write(sessionId, 'x')).toBe(false)
  })

  it('kills a session and refuses unknown folders and duplicate ids', async () => {
    const sessionId = randomId()
    await service.create({ sessionId, cols: 80, rows: 24 })
    await new Promise((r) => setTimeout(r, 200))
    expect(service.kill(sessionId)).toBe(true)
    await waitFor(() => exits.some((e) => e.sessionId === sessionId), 'exit after kill', sessionId)
    await expect(service.create({ sessionId, cols: 80, rows: 24 })).rejects.toThrow(/existiert/)
    await expect(
      service.create({ sessionId: randomId(), cwd: join(dir, 'fehlt'), cols: 80, rows: 24 }),
    ).rejects.toThrow(/nicht gefunden/)
  })

  it('runs the bundled claude through the wrapper and logs its usage', async () => {
    const sessionId = randomId()
    const project = join(dir, 'projekt')
    mkdirSync(project)
    await service.create({ sessionId, cwd: project, cols: 120, rows: 40 })
    // What the "Claude Code starten" button does.
    service.write(sessionId, 'claude\r')

    // First start in a fresh config dir: theme, security note, folder trust.
    let mark = 0
    const answered = new Set<string>()
    await waitFor(
      () => {
        const s = screen(sessionId, mark)
        if (s.includes('shift+tabtocycle') || s.includes('forshortcuts')) return true
        // Keys are sent one by one with a pause, like a person would.
        const step = (key: string, text: string, keys: string[]) => {
          if (answered.has(key) || !s.includes(text)) return false
          answered.add(key)
          mark = (output.get(sessionId) ?? '').length
          keys.forEach((k, i) => setTimeout(() => service.write(sessionId, k), 300 * (i + 1)))
          return true
        }
        if (!step('theme', 'Choosethetextstyle', ['\r'])) {
          if (!step('security', 'PressEntertocontinue', ['\r'])) {
            step('trust', 'Yes,Itrustthisfolder', ['\x1b[B', '\r'])
          }
        }
        return false
      },
      'claude prompt',
      sessionId,
      60_000,
    )
    await new Promise((r) => setTimeout(r, 1000))
    mark = (output.get(sessionId) ?? '').length
    service.write(sessionId, 'Hallo Welt')
    await new Promise((r) => setTimeout(r, 300))
    service.write(sessionId, '\r')
    await waitFor(() => screen(sessionId, mark).includes('Mock-Antwort42'), 'answer', sessionId)
    await new Promise((r) => setTimeout(r, 500))
    service.write(sessionId, '/exit')
    await new Promise((r) => setTimeout(r, 300))
    service.write(sessionId, '\r')
    await waitFor(() => screen(sessionId, mark).includes('claude--resume'), 'exit', sessionId)
    // Input typed while claude is still shutting down would be swallowed by it.
    await new Promise((r) => setTimeout(r, 2000))

    // User arguments pass through the wrapper (non-interactive run with another model).
    mark = (output.get(sessionId) ?? '').length
    service.write(sessionId, 'claude -p "Zweite Frage" --model mock-model-b\r')
    await waitFor(() => screen(sessionId, mark).includes('AntwortB'), 'print answer', sessionId)
    service.write(sessionId, 'exit\r')
    await waitFor(() => exits.some((e) => e.sessionId === sessionId), 'shell exit', sessionId)
    // The final OTLP export arrives when claude exits; give it a moment, then log open turns.
    await new Promise((r) => setTimeout(r, 1500))
    service.flushUsage()

    const messages = mock.requests.filter((r) => r.path === '/v1/messages')
    const bodies = messages.map((r) => JSON.stringify(r.body))
    expect(bodies.some((b) => b.includes(TERMINAL_SYSTEM_NOTE.slice(0, 60)))).toBe(true)
    expect(messages.some((r) => (r.body as { model?: string }).model === 'mock-model-b')).toBe(true)
    // Effort reaches the API as output_config.effort.
    const efforts = messages.map(
      (r) => (r.body as { output_config?: { effort?: string } }).output_config?.effort,
    )
    expect(efforts).toContain('low')

    const rows = db
      .prepare(
        'SELECT chat_id, agent, provider, model, input_tokens, output_tokens, cost_usd FROM usage',
      )
      .all() as {
      chat_id: string
      agent: string
      provider: string
      model: string
      input_tokens: number
      output_tokens: number
      cost_usd: number
    }[]
    const terminalRows = rows.filter((r) => r.chat_id === `terminal:${sessionId}`)
    expect(terminalRows.length).toBeGreaterThan(0)
    expect(terminalRows.every((r) => r.agent === 'terminal' && r.provider === 'ollama')).toBe(true)
    expect(new Set(terminalRows.map((r) => r.model))).toEqual(
      new Set(['mock-model', 'mock-model-b']),
    )
    // The mock reports 10 input / 5 output tokens per call; Ollama is free.
    const input = terminalRows.reduce((sum, r) => sum + r.input_tokens, 0)
    expect(input).toBe(messages.length * 10)
    expect(terminalRows.every((r) => r.cost_usd === 0)).toBe(true)
    const summary = usage.summary('today')
    expect(summary.byAgent.find((a) => a.agent === 'terminal')?.requests).toBeGreaterThanOrEqual(2)
  }, 150_000)
})
