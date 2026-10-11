import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/schemas/settings'
import type { TerminalExitEvent } from '@shared/schemas/terminal'
import { resolveClaudeExecutable } from '../../src/main/agent/executable'
import { sandboxStatus } from '../../src/main/agent/sandbox'
import { TerminalService } from '../../src/main/terminal/service'
import { startMockAnthropic, type MockAnthropic, type MockTurn } from '../../scripts/mock-anthropic'

interface Body {
  tools?: unknown[]
  messages?: { role: string; content: string | { type: string; content?: unknown }[] }[]
}

/** Contents of all tool results in a request, in order. */
function toolResults(body: unknown): string[] {
  return ((body as Body).messages ?? []).flatMap((m) =>
    Array.isArray(m.content)
      ? m.content.filter((b) => b.type === 'tool_result').map((b) => JSON.stringify(b.content))
      : [],
  )
}

const sandbox = sandboxStatus()

// Real PTY + bundled runtime through the `claude` wrapper; Windows is covered by unit tests.
describe.skipIf(process.platform === 'win32')(
  'claude in the terminal, confined to its folder',
  () => {
    let mock: MockAnthropic
    let dir: string
    let work: string
    let secret: string
    let service: TerminalService
    const output = new Map<string, string>()
    const exits: TerminalExitEvent[] = []
    const settings: Settings = { ...DEFAULT_SETTINGS }
    const originalHome = process.env['HOME']
    let script: MockTurn['toolUse'][] = []

    beforeAll(async () => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), 'aiw-term-confine-')))
      // The sandbox hides the home directory; use a throwaway one with a "private" file.
      process.env['HOME'] = join(dir, 'home')
      mkdirSync(join(dir, 'home'))
      secret = join(dir, 'home', 'secret.txt')
      writeFileSync(secret, 'GEHEIM-HOME')
      work = join(dir, 'arbeitsordner')
      mkdirSync(work)
      writeFileSync(join(work, 'innen.txt'), 'HALLO-INNEN')

      mock = await startMockAnthropic((body) => {
        const b = body as Body
        if (!JSON.stringify(b.messages?.[0] ?? '').includes('TERM-CONFINE') || !b.tools?.length) {
          return 'ok'
        }
        const step = toolResults(body).length
        const tool = script[step]
        return tool ? { text: `Schritt ${step}`, toolUse: tool } : { text: 'Fertig.' }
      })
      Object.assign(settings, {
        activeProvider: 'ollama',
        ollamaBaseUrl: mock.url,
        models: { ...DEFAULT_SETTINGS.models, ollama: 'mock-model' },
        // Auto mode needs a Claude classifier; with Ollama the app passes acceptEdits instead.
        claudePermissionMode: 'auto',
        confineToWorkFolder: true,
      } satisfies Partial<Settings>)
      service = new TerminalService({
        dataDir: join(dir, 'data'),
        appVersion: 'test',
        claudeExecutable: resolveClaudeExecutable(),
        getSettings: () => settings,
        getSecret: () => undefined,
        baseEnv: { ...process.env, HOME: join(dir, 'home') },
        emitData: ({ sessionId, data }) =>
          output.set(sessionId, (output.get(sessionId) ?? '') + data),
        emitExit: (event) => exits.push(event),
      })
    })

    afterAll(async () => {
      if (originalHome === undefined) delete process.env['HOME']
      else process.env['HOME'] = originalHome
      await service.dispose()
      await mock.close()
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    })

    async function waitFor(check: () => boolean, what: string, sessionId: string, ms = 90_000) {
      const started = Date.now()
      while (!check()) {
        if (Date.now() - started > ms) {
          throw new Error(`Timeout: ${what}\n${(output.get(sessionId) ?? '').slice(-2000)}`)
        }
        await new Promise((r) => setTimeout(r, 100))
      }
    }

    const sessionsDir = () => join(dir, 'data', 'terminal', 'sessions')

    /** Runs `claude -p` through the wrapper in a new shell and returns the tool results. */
    async function runClaude(marker: string): Promise<string[]> {
      const sessionId = crypto.randomUUID()
      const created = await service.create({ sessionId, cwd: work, cols: 120, rows: 40 })
      expect(created.claude.workFolder).toBe(work)
      expect(created.claude.sandbox).toBe(sandbox.active)
      // The session's settings file exists while the shell runs.
      expect(readdirSync(sessionsDir())).toContain(`${sessionId}.json`)
      service.write(sessionId, `claude -p "TERM-CONFINE ${marker}"; echo CLAUDE-""FERTIG\r`)
      await waitFor(
        () => (output.get(sessionId) ?? '').includes('CLAUDE-FERTIG'),
        'claude -p',
        sessionId,
      )
      const results = mock.requests
        .filter((r) => r.path === '/v1/messages' && JSON.stringify(r.body).includes(marker))
        .map((r) => toolResults(r.body))
        .reduce((a, b) => (b.length > a.length ? b : a), [])
      service.write(sessionId, 'exit\r')
      await waitFor(() => exits.some((e) => e.sessionId === sessionId), 'exit', sessionId)
      // Ended sessions leave no settings file behind (the guard forgets them, too).
      expect(readdirSync(sessionsDir())).not.toContain(`${sessionId}.json`)
      return results
    }

    it('denies file tools outside the folder and allows them inside', async () => {
      script = [
        { name: 'Read', input: { file_path: secret } },
        { name: 'Read', input: { file_path: join(work, 'innen.txt') } },
        // Only succeeds without a prompt if --permission-mode acceptEdits reached the runtime.
        { name: 'Write', input: { file_path: join(work, 'neu.txt'), content: 'vom Agenten' } },
        { name: 'Write', input: { file_path: join(dir, 'raus.txt'), content: 'x' } },
      ]
      const probe = crypto.randomUUID()
      const created = await service.create({ sessionId: probe, cwd: work, cols: 80, rows: 24 })
      // Auto mode needs a Claude classifier; with Ollama the app passes acceptEdits instead.
      expect(created.claude.permissionMode).toBe('acceptEdits')
      expect(created.claude.modeNote).toMatch(/Ollama/)
      service.kill(probe)

      const results = await runClaude('dateien')
      expect(results.length).toBe(script.length)
      const [readOutside = '', readInside = '', writeInside = '', writeOutside = ''] = results
      expect(readOutside).toContain('Von AI Workbench blockiert')
      expect(readOutside).not.toContain('GEHEIM-HOME')
      expect(readInside).toContain('HALLO-INNEN')
      expect(writeInside).toContain('File created successfully')
      expect(existsSync(join(work, 'neu.txt'))).toBe(true)
      expect(writeOutside).toContain('Von AI Workbench blockiert')
      expect(existsSync(join(dir, 'raus.txt'))).toBe(false)
    }, 180_000)

    it('stays confined in "Alles erlauben": guard, protected files and sandbox', async () => {
      settings.claudePermissionMode = 'bypassPermissions'
      try {
        script = [
          { name: 'Read', input: { file_path: secret } },
          { name: 'Write', input: { file_path: join(work, '.mcp.json'), content: '{}' } },
          {
            name: 'Bash',
            input: {
              command: `cat ${secret}; echo x > ${join(dir, 'bash-raus.txt')}; echo SANDBOX-ENDE`,
              description: 'Sandbox prüfen',
            },
          },
        ]
        const results = await runClaude('alles')
        expect(results.length).toBe(script.length)
        const [readOutside = '', protectedWrite = '', bash = ''] = results
        expect(readOutside).toContain('Von AI Workbench blockiert')
        expect(protectedWrite).toContain('Alles erlauben')
        expect(existsSync(join(work, '.mcp.json'))).toBe(false)
        expect(bash).toContain('SANDBOX-ENDE')
        if (sandbox.active) {
          expect(bash).not.toContain('GEHEIM-HOME')
          expect(existsSync(join(dir, 'bash-raus.txt'))).toBe(false)
        } else {
          // Without the OS sandbox, shell commands are NOT confined – the app says so.
          console.warn(`[terminal] OS-Sandbox nicht verfügbar: ${sandbox.summary}`)
          expect(bash).toContain('GEHEIM-HOME')
        }
      } finally {
        settings.claudePermissionMode = 'auto'
      }
    }, 180_000)

    it('starts claude unconfined when the setting is off', async () => {
      settings.confineToWorkFolder = false
      settings.claudePermissionMode = 'default'
      try {
        const sessionId = crypto.randomUUID()
        const created = await service.create({ sessionId, cwd: work, cols: 100, rows: 30 })
        expect(created.claude).toMatchObject({
          permissionMode: 'default',
          workFolder: null,
          modeNote: null,
          sandbox: false,
        })
        expect(readdirSync(sessionsDir())).not.toContain(`${sessionId}.json`)
        service.kill(sessionId)
        await waitFor(() => exits.some((e) => e.sessionId === sessionId), 'exit', sessionId)
      } finally {
        settings.confineToWorkFolder = true
        settings.claudePermissionMode = 'auto'
      }
    }, 60_000)
  },
)
