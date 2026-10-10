import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, ChatRequest } from '@shared/schemas/agent'
import type { Settings } from '@shared/schemas/settings'
import type { SecretStore } from '../storage/secret-store'
import { buildProviderRuntime } from './providers'
import { normalizeSdkMessage, type SdkMessageLike } from './normalize'

export interface SessionManagerDeps {
  getSettings: () => Settings
  secrets: SecretStore
  /** Root directory for per-session workspaces and the isolated agent config. */
  dataDir: string
  appVersion: string
  executablePath: string
  emit: (event: AgentEvent) => void
}

interface ActiveRun {
  abort: AbortController
}

/** Runs Claude Agent SDK queries per chat session and streams normalized events. */
export class SessionManager {
  private readonly active = new Map<string, ActiveRun>()
  /** Maps our chat session id to the SDK session id so follow-ups resume the conversation. */
  private readonly sdkSessions = new Map<string, string>()

  constructor(private readonly deps: SessionManagerDeps) {}

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  /** Starts a run in the background. Returns false if the session is already busy. */
  send(request: ChatRequest): boolean {
    if (this.active.has(request.sessionId)) return false
    const run: ActiveRun = { abort: new AbortController() }
    this.active.set(request.sessionId, run)
    void this.execute(request, run).finally(() => {
      this.active.delete(request.sessionId)
      this.deps.emit({ sessionId: request.sessionId, type: 'done' })
    })
    return true
  }

  cancel(sessionId: string): boolean {
    const run = this.active.get(sessionId)
    if (!run) return false
    run.abort.abort()
    return true
  }

  cancelAll(): void {
    for (const run of this.active.values()) run.abort.abort()
  }

  private async execute(request: ChatRequest, run: ActiveRun): Promise<void> {
    const { sessionId } = request
    const { emit } = this.deps
    try {
      const settings = this.deps.getSettings()
      const provider = settings.activeProvider
      const runtime = buildProviderRuntime({
        provider,
        settings,
        secret: this.deps.secrets.get(provider),
        baseEnv: process.env,
        configDir: join(this.deps.dataDir, 'agent-config'),
        appVersion: this.deps.appVersion,
      })

      const cwd = request.cwd ?? join(this.deps.dataDir, 'sessions', sessionId)
      mkdirSync(cwd, { recursive: true })

      const resume = this.sdkSessions.get(sessionId)
      const options: Options = {
        cwd,
        env: runtime.env,
        pathToClaudeCodeExecutable: this.deps.executablePath,
        abortController: run.abort,
        includePartialMessages: true,
        // Chat mode: no built-in tools and no filesystem settings until the coding mode lands.
        tools: [],
        settingSources: [],
        persistSession: true,
        ...(runtime.model ? { model: runtime.model } : {}),
        ...(resume ? { resume } : {}),
      }

      for await (const message of query({ prompt: request.prompt, options })) {
        if (message.type === 'system' && message.subtype === 'init') {
          this.sdkSessions.set(sessionId, message.session_id)
        }
        for (const event of normalizeSdkMessage(sessionId, message as SdkMessageLike)) emit(event)
      }
    } catch (error) {
      if (run.abort.signal.aborted) return
      emit({
        sessionId,
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
