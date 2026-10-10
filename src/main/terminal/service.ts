import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ProviderId, Settings } from '@shared/schemas/settings'
import type {
  TerminalCreated,
  TerminalDataEvent,
  TerminalExitEvent,
} from '@shared/schemas/terminal'
import type { UsageRepository } from '../storage/usage-repository'
import { buildTerminalEnv } from './env'
import { PtySession, type PtyModule } from './pty'
import { defaultShell, terminalBinDir, type ShellSpec } from './shell'
import { OtlpLogsReceiver, TerminalUsageCollector } from './usage'
import { installClaudeWrapper } from './wrapper'

export interface TerminalServiceDeps {
  dataDir: string
  appVersion: string
  /** Bundled Claude Code runtime (see ../agent/executable.ts). */
  claudeExecutable: string
  getSettings: () => Settings
  getSecret: (provider: ProviderId) => string | undefined
  /** Usage log; without it terminal sessions are not tracked. */
  usage?: Pick<UsageRepository, 'record'>
  emitData: (event: TerminalDataEvent) => void
  emitExit: (event: TerminalExitEvent) => void
  /** Overrides for tests. */
  baseEnv?: Record<string, string | undefined>
  shell?: ShellSpec
  ptyModule?: PtyModule
  /** Changes the environment of new sessions (tests). */
  adjustEnv?: (env: Record<string, string>) => void
  usageIdleMs?: number
}

export interface CreateTerminalInput {
  sessionId: string
  cwd?: string | undefined
  cols: number
  rows: number
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Delay before the open usage of an ended session is logged (its last export may be in flight). */
const EXIT_FLUSH_DELAY_MS = 3000

/**
 * Interactive terminal sessions with the bundled Claude Code available as `claude`.
 *
 * `claude` shares CLAUDE_CONFIG_DIR with the in-app agent (dataDir/agent-config): installed
 * skills live there, onboarding and folder trust are only answered once, and sessions of the
 * coding mode can be resumed in the terminal (`claude --resume`) and the other way round.
 * The trade-off: user-level settings changed in the terminal (e.g. /config, permission rules
 * saved as "always allow") also apply to the in-app coding agent, which loads the same user
 * settings. Claude Code supports several processes on one config dir, as with ~/.claude.
 */
export class TerminalService {
  private readonly sessions = new Map<string, PtySession>()
  /** Provider per session of this app run, kept after exit so late usage events still count. */
  private readonly providers = new Map<string, ProviderId>()
  private readonly collector: TerminalUsageCollector | undefined
  private readonly receiver: OtlpLogsReceiver | undefined

  constructor(private readonly deps: TerminalServiceDeps) {
    if (deps.usage) {
      const collector = new TerminalUsageCollector({
        usage: deps.usage,
        providerOf: (id) => this.providers.get(id),
        ...(deps.usageIdleMs !== undefined ? { idleMs: deps.usageIdleMs } : {}),
      })
      this.collector = collector
      this.receiver = new OtlpLogsReceiver((events) => collector.add(events))
    }
  }

  get configDir(): string {
    return join(this.deps.dataDir, 'agent-config')
  }

  async create(input: CreateTerminalInput): Promise<TerminalCreated> {
    const { sessionId, cols, rows } = input
    if (this.sessions.has(sessionId) || this.providers.has(sessionId)) {
      throw new Error('Diese Terminal-Sitzung existiert bereits.')
    }
    const cwd = resolve(input.cwd ?? homedir())
    if (!isDirectory(cwd)) throw new Error(`Ordner nicht gefunden: ${cwd}`)

    const binDir = terminalBinDir(this.deps.dataDir)
    installClaudeWrapper(binDir, this.deps.claudeExecutable)
    const usage = this.receiver ? await this.receiver.start() : undefined
    const settings = this.deps.getSettings()
    const { env, provider, notice } = buildTerminalEnv({
      settings,
      secret: this.deps.getSecret(settings.activeProvider),
      baseEnv: this.deps.baseEnv ?? process.env,
      configDir: this.configDir,
      appVersion: this.deps.appVersion,
      binDir,
      claudeExecutable: this.deps.claudeExecutable,
      sessionId,
      ...(usage ? { usage } : {}),
    })
    this.deps.adjustEnv?.(env)
    const shell = this.deps.shell ?? defaultShell(process.platform, env)

    let session: PtySession
    try {
      session = new PtySession(
        { file: shell.file, args: shell.args, cwd, env, cols, rows },
        {
          onData: (data) => this.deps.emitData({ sessionId, data }),
          onExit: (exitCode, signal) => {
            this.sessions.delete(sessionId)
            this.deps.emitExit({ sessionId, exitCode, signal })
            setTimeout(() => this.collector?.flushTerminal(sessionId), EXIT_FLUSH_DELAY_MS).unref()
          },
        },
        this.deps.ptyModule,
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Shell konnte nicht gestartet werden (${shell.file}): ${reason}`, {
        cause: error,
      })
    }
    this.providers.set(sessionId, provider)
    if (session.running) this.sessions.set(sessionId, session)
    return { sessionId, cwd, shell: shell.file, notice }
  }

  write(sessionId: string, data: string, binary = false): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.write(binary ? Buffer.from(data, 'latin1') : data)
    return true
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.resize(cols, rows)
    return true
  }

  kill(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.kill()
    return true
  }

  killAll(): void {
    for (const session of this.sessions.values()) session.kill()
  }

  /** Number of shells that are still running. */
  get activeCount(): number {
    return this.sessions.size
  }

  /** Logs usage that is still open (e.g. on quit). */
  flushUsage(): void {
    this.collector?.flushAll()
  }

  async dispose(): Promise<void> {
    this.killAll()
    this.flushUsage()
    await this.receiver?.close()
  }
}
