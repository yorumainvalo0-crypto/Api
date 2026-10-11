import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/schemas/settings'
import {
  buildTerminalEnv,
  bypassProxyForLoopback,
  type TerminalEnvArgs,
} from '../src/main/terminal/env'
import { defaultShell, envValue, prependPath } from '../src/main/terminal/shell'
import {
  claudeWrapper,
  installClaudeWrapper,
  shQuote,
  TERMINAL_SYSTEM_NOTE,
} from '../src/main/terminal/wrapper'

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch })

function args(patch: Partial<TerminalEnvArgs> = {}): TerminalEnvArgs {
  return {
    settings: settings(),
    secret: 'sk-test',
    baseEnv: { PATH: '/usr/bin', HOME: '/home/max', SHELL: '/bin/zsh' },
    configDir: '/data/agent-config',
    appVersion: '1.2.3',
    binDir: '/data/terminal/bin',
    claudeExecutable: '/app/claude',
    sessionId: 'abc',
    platform: 'linux',
    ...patch,
  }
}

describe('defaultShell', () => {
  it('prefers pwsh on Windows and falls back to Windows PowerShell', () => {
    const env = { Path: 'C:\\Windows;C:\\Program Files\\PowerShell\\7' }
    const withPwsh = defaultShell(
      'win32',
      env,
      (f) => f === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    )
    expect(withPwsh.file).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(withPwsh.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command'])
    expect(withPwsh.args).not.toContain('-NoProfile')
    expect(defaultShell('win32', env, () => false).file).toBe('powershell.exe')
  })

  it('uses $SHELL, then bash, then sh elsewhere; login shell on macOS', () => {
    expect(defaultShell('linux', { SHELL: '/bin/zsh' }, () => true)).toEqual({
      file: '/bin/zsh',
      args: [],
    })
    expect(defaultShell('linux', { SHELL: '/gibt/es/nicht' }, (f) => f === '/bin/bash').file).toBe(
      '/bin/bash',
    )
    expect(defaultShell('linux', {}, () => false).file).toBe('/bin/sh')
    expect(defaultShell('darwin', { SHELL: '/bin/zsh' }, () => true).args).toEqual(['-l'])
  })
})

describe('PATH handling', () => {
  it('keeps the Windows spelling of Path and prepends the wrapper folder', () => {
    const env: Record<string, string> = { Path: 'C:\\Windows' }
    prependPath(env, 'C:\\Data\\terminal\\bin', 'win32')
    expect(env).toEqual({ Path: 'C:\\Data\\terminal\\bin;C:\\Windows' })
    expect(envValue(env, 'PATH', 'win32')).toBe('C:\\Data\\terminal\\bin;C:\\Windows')
    const posix: Record<string, string> = { PATH: '/usr/bin' }
    prependPath(posix, '/data/bin', 'linux')
    expect(posix['PATH']).toBe('/data/bin:/usr/bin')
  })
})

describe('buildTerminalEnv', () => {
  it('gives claude the Anthropic key, model and effort of the app', () => {
    const { env, provider, notice } = buildTerminalEnv(
      args({
        settings: settings({
          activeProvider: 'anthropic',
          models: { ...DEFAULT_SETTINGS.models, anthropic: 'claude-sonnet-4-5' },
          effort: 'high',
        }),
        baseEnv: {
          PATH: '/usr/bin',
          ANTHROPIC_API_KEY: 'sk-own',
          CLAUDE_CONFIG_DIR: '/home/max/.claude',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector',
          TERM_PROGRAM: 'vscode',
          ELECTRON_RUN_AS_NODE: '1',
        },
        usage: { endpoint: 'http://127.0.0.1:1234/v1/logs', token: 'tok' },
      }),
    )
    expect(provider).toBe('anthropic')
    expect(notice).toBeNull()
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
      CLAUDE_CONFIG_DIR: '/data/agent-config',
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      PATH: '/data/terminal/bin:/usr/bin',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      AIW_TERMINAL_SESSION: 'abc',
      AIW_CLAUDE_EXE: '/app/claude',
      AIW_OTEL_ENDPOINT: 'http://127.0.0.1:1234/v1/logs',
      AIW_OTEL_TOKEN: 'tok',
    })
    expect(env['ANTHROPIC_BASE_URL']).toBeUndefined()
    expect(env['OTEL_EXPORTER_OTLP_ENDPOINT']).toBeUndefined()
    expect(env['TERM_PROGRAM']).toBeUndefined()
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined()
  })

  it('leaves model and effort unset for "default" and effort out for Ollama', () => {
    const anthropic = buildTerminalEnv(args()).env
    expect(anthropic['ANTHROPIC_MODEL']).toBeUndefined()
    expect(anthropic['CLAUDE_CODE_EFFORT_LEVEL']).toBeUndefined()
    const ollama = buildTerminalEnv(
      args({
        secret: undefined,
        settings: settings({
          activeProvider: 'ollama',
          ollamaBaseUrl: 'http://localhost:11434/',
          models: { ...DEFAULT_SETTINGS.models, ollama: 'qwen3-coder' },
          effort: 'max',
        }),
      }),
    ).env
    expect(ollama).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://localhost:11434',
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: 'qwen3-coder',
    })
    expect(ollama['CLAUDE_CODE_EFFORT_LEVEL']).toBeUndefined()
    expect(ollama['AIW_OTEL_ENDPOINT']).toBeUndefined()
  })

  it('routes OpenRouter through its Anthropic-compatible endpoint', () => {
    const { env } = buildTerminalEnv(
      args({
        secret: 'or-key',
        settings: settings({
          activeProvider: 'openrouter',
          models: { ...DEFAULT_SETTINGS.models, openrouter: 'anthropic/claude-opus-4' },
          effort: 'low',
        }),
      }),
    )
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: 'or-key',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: 'anthropic/claude-opus-4',
      CLAUDE_CODE_EFFORT_LEVEL: 'low',
    })
  })

  it('still opens a shell without credentials and explains why', () => {
    const { env, notice } = buildTerminalEnv(
      args({ secret: undefined, baseEnv: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-own' } }),
    )
    expect(notice).toMatch(/Kein Anthropic API-Key/)
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/data/agent-config')
    expect(env['PATH']).toBe('/data/terminal/bin:/usr/bin')
  })

  it('sets a UTF-8 locale only when none is inherited', () => {
    expect(buildTerminalEnv(args()).env['LANG']).toBe('C.UTF-8')
    expect(buildTerminalEnv(args({ baseEnv: { LANG: 'de_DE.UTF-8' } })).env['LANG']).toBe(
      'de_DE.UTF-8',
    )
    const win = buildTerminalEnv(args({ platform: 'win32', baseEnv: { Path: 'C:\\Windows' } })).env
    expect(win['LANG']).toBeUndefined()
    expect(win['TERM']).toBeUndefined()
    expect(win['Path']).toBe('/data/terminal/bin;C:\\Windows')
  })

  it('passes permission mode and settings file to the wrapper, never inherited ones', () => {
    const inherited = {
      PATH: '/usr/bin',
      AIW_CLAUDE_SETTINGS: '/alt.json',
      AIW_PERMISSION_MODE: 'x',
    }
    const plain = buildTerminalEnv(args({ baseEnv: inherited })).env
    expect(plain['AIW_CLAUDE_SETTINGS']).toBeUndefined()
    expect(plain['AIW_PERMISSION_MODE']).toBeUndefined()
    const confined = buildTerminalEnv(
      args({
        baseEnv: inherited,
        claude: { permissionMode: 'auto', settingsFile: '/data/terminal/sessions/abc.json' },
      }),
    ).env
    expect(confined['AIW_PERMISSION_MODE']).toBe('auto')
    expect(confined['AIW_CLAUDE_SETTINGS']).toBe('/data/terminal/sessions/abc.json')
    const open = buildTerminalEnv(args({ claude: { permissionMode: 'default' } })).env
    expect(open['AIW_PERMISSION_MODE']).toBe('default')
    expect(open['AIW_CLAUDE_SETTINGS']).toBeUndefined()
  })

  it('keeps loopback off the proxy, so the path guard hook reaches the app', () => {
    const none: Record<string, string> = { PATH: '/usr/bin' }
    bypassProxyForLoopback(none, 'linux')
    expect(none).toEqual({ PATH: '/usr/bin' })
    const linux: Record<string, string> = { https_proxy: 'http://p:8080', no_proxy: 'intra.lan' }
    bypassProxyForLoopback(linux, 'linux')
    expect(linux['no_proxy']).toBe('intra.lan,127.0.0.1,localhost')
    expect(linux['NO_PROXY']).toBeUndefined()
    const fresh: Record<string, string> = { HTTP_PROXY: 'http://p:8080' }
    bypassProxyForLoopback(fresh, 'linux')
    expect(fresh['NO_PROXY']).toBe('127.0.0.1,localhost')
    expect(fresh['no_proxy']).toBe('127.0.0.1,localhost')
    const win: Record<string, string> = { HTTPS_PROXY: 'http://p', No_Proxy: 'localhost' }
    bypassProxyForLoopback(win, 'win32')
    expect(win).toEqual({ HTTPS_PROXY: 'http://p', No_Proxy: 'localhost,127.0.0.1' })
  })
})

describe('claude wrapper', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-wrapper-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps the system note safe for .cmd files', () => {
    expect(TERMINAL_SYSTEM_NOTE).not.toMatch(/["%!\r\n]/)
    expect(TERMINAL_SYSTEM_NOTE).toMatch(/AI Workbench/)
  })

  it('writes a .cmd for Windows that forwards all arguments', () => {
    const wrapper = claudeWrapper('C:\\Users\\Max 100%\\AI Workbench\\claude.exe', 'win32')
    expect(wrapper.name).toBe('claude.cmd')
    expect(wrapper.content).toContain('\r\n')
    const lines = wrapper.content.split('\r\n')
    expect(lines[0]).toBe('@echo off')
    // The runtime path comes from the environment (non-ASCII user names), the literal is a fallback.
    expect(lines).toContain(
      'if not defined AIW_CLAUDE_EXE set "AIW_CLAUDE_EXE=C:\\Users\\Max 100%%\\AI Workbench\\claude.exe"',
    )
    expect(lines).toContain(
      `"%AIW_CLAUDE_EXE%" --append-system-prompt "${TERMINAL_SYSTEM_NOTE}" %AIW_MODE_FLAG% %*`,
    )
    // Work folder confinement and permission mode of the session, from the environment.
    expect(lines).toContain('set "AIW_MODE_FLAG="')
    expect(lines).toContain(
      'if defined AIW_PERMISSION_MODE set "AIW_MODE_FLAG=--permission-mode %AIW_PERMISSION_MODE%"',
    )
    expect(lines).toContain('if defined AIW_CLAUDE_SETTINGS goto confined')
    expect(lines).toContain(
      `"%AIW_CLAUDE_EXE%" --append-system-prompt "${TERMINAL_SYSTEM_NOTE}" --settings "%AIW_CLAUDE_SETTINGS%" %AIW_MODE_FLAG% %*`,
    )
    // Everything outside the fallback path is plain ASCII (cmd decodes in the console code page).
    const generic = claudeWrapper('C:\\Users\\Jörg\\claude.exe', 'win32').content
    expect(
      generic
        .replace('Jörg', '')
        .split('')
        .every((c) => c.charCodeAt(0) < 128),
    ).toBe(true)
    expect(lines).toContain('set "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=%AIW_OTEL_ENDPOINT%"')
    expect(lines).toContain('set "OTEL_RESOURCE_ATTRIBUTES=aiw.terminal=%AIW_TERMINAL_SESSION%"')
    expect(() => claudeWrapper('C:\\a"b\\claude.exe', 'win32')).toThrow()
  })

  it('quotes for sh', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`)
  })

  it.skipIf(process.platform === 'win32')(
    'runs the runtime with the note and passes arguments through (sh)',
    () => {
      // A fake runtime that prints its arguments and telemetry settings.
      const fake = join(dir, "fake claude's")
      writeFileSync(
        fake,
        '#!/bin/sh\nfor a in "$@"; do echo "ARG:$a"; done\necho "OTEL:$OTEL_RESOURCE_ATTRIBUTES"\n',
        { mode: 0o755 },
      )
      const file = installClaudeWrapper(join(dir, 'bin'), fake, 'linux')
      expect(statSync(file).mode & 0o111).not.toBe(0)
      const run = (env: Record<string, string>) =>
        execFileSync(file, ['-p', 'Hallo "Welt"', '--model', 'x y'], {
          encoding: 'utf8',
          env: { PATH: '/usr/bin:/bin', ...env },
        })
      expect(run({}).split('\n')).toEqual([
        'ARG:--append-system-prompt',
        `ARG:${TERMINAL_SYSTEM_NOTE}`,
        'ARG:-p',
        'ARG:Hallo "Welt"',
        'ARG:--model',
        'ARG:x y',
        'OTEL:',
        '',
      ])
      const withUsage = run({
        AIW_OTEL_ENDPOINT: 'http://127.0.0.1:9/v1/logs',
        AIW_OTEL_TOKEN: 't',
        AIW_TERMINAL_SESSION: 's1',
      })
      expect(withUsage).toContain('OTEL:aiw.terminal=s1')
      // Settings file and permission mode come before the user's arguments (theirs win).
      const confined = run({
        AIW_CLAUDE_SETTINGS: '/data/terminal/sessions/a b.json',
        AIW_PERMISSION_MODE: 'auto',
      }).split('\n')
      expect(confined.slice(0, 7)).toEqual([
        'ARG:--append-system-prompt',
        `ARG:${TERMINAL_SYSTEM_NOTE}`,
        'ARG:--settings',
        'ARG:/data/terminal/sessions/a b.json',
        'ARG:--permission-mode',
        'ARG:auto',
        'ARG:-p',
      ])
      // Rewriting with the same content keeps the file untouched.
      const before = readFileSync(file, 'utf8')
      installClaudeWrapper(join(dir, 'bin'), fake, 'linux')
      expect(readFileSync(file, 'utf8')).toBe(before)
    },
  )
})
