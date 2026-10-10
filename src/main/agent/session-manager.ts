import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, ChatRequest } from '@shared/schemas/agent'
import type { Attachment } from '@shared/schemas/chat'
import type { Settings } from '@shared/schemas/settings'
import type { SecretStore } from '../storage/secret-store'
import type { ChatRepository } from '../storage/chat-repository'
import { buildPromptBlocks } from '../workspace/attachments'
import { isInside } from '../workspace/paths'
import { buildProviderRuntime } from './providers'
import { normalizeSdkMessage, type SdkMessageLike } from './normalize'

export interface SessionManagerDeps {
  getSettings: () => Settings
  secrets: SecretStore
  chats: ChatRepository
  /** Root directory for per-chat workspaces and the isolated agent config. */
  dataDir: string
  appVersion: string
  executablePath: string
  emit: (event: AgentEvent) => void
}

interface ActiveRun {
  abort: AbortController
}

/** Collects streamed output into the assistant message that gets persisted. */
class AssistantDraft {
  text = ''
  streamed = false
  tools: string[] = []
  error: string | null = null
  costUsd: number | null = null
  durationMs: number | null = null

  apply(event: AgentEvent): void {
    switch (event.type) {
      case 'text-delta':
        this.streamed = true
        this.text += event.text
        break
      case 'assistant-text':
        if (!this.streamed) this.text = this.text ? `${this.text}\n\n${event.text}` : event.text
        break
      case 'tool-use':
        this.tools.push(event.name)
        break
      case 'result':
        this.costUsd = event.costUsd
        this.durationMs = event.durationMs
        if (event.isError) this.error = event.text || 'Unbekannter Fehler'
        break
      case 'error':
        this.error = event.message
        break
      default:
        break
    }
  }
}

export function chatWorkspace(dataDir: string, chatId: string): string {
  return join(dataDir, 'chats', chatId)
}

export function chatAttachmentsDir(dataDir: string, chatId: string): string {
  return join(chatWorkspace(dataDir, chatId), 'attachments')
}

/** Runs Claude Agent SDK queries per chat and streams normalized events. */
export class SessionManager {
  private readonly active = new Map<string, ActiveRun>()

  constructor(private readonly deps: SessionManagerDeps) {}

  isRunning(chatId: string): boolean {
    return this.active.has(chatId)
  }

  /** Starts a run in the background. Returns false if the chat is already busy. */
  send(request: ChatRequest): boolean {
    if (this.active.has(request.chatId)) return false
    if (!request.prompt.trim() && request.attachments.length === 0) return false
    const run: ActiveRun = { abort: new AbortController() }
    this.active.set(request.chatId, run)
    void this.execute(request, run).finally(() => {
      this.active.delete(request.chatId)
      this.deps.emit({ chatId: request.chatId, type: 'done' })
    })
    return true
  }

  cancel(chatId: string): boolean {
    const run = this.active.get(chatId)
    if (!run) return false
    run.abort.abort()
    return true
  }

  cancelAll(): void {
    for (const run of this.active.values()) run.abort.abort()
  }

  private async execute(request: ChatRequest, run: ActiveRun): Promise<void> {
    const { chatId } = request
    const { chats, dataDir } = this.deps
    const draft = new AssistantDraft()
    const emit = (event: AgentEvent): void => {
      draft.apply(event)
      this.deps.emit(event)
    }

    try {
      const settings = this.deps.getSettings()
      const provider = settings.activeProvider
      const modelLabel = settings.models[provider] || 'Standard'

      // Only accept attachments that were stored in this chat's folder by the main process.
      const attachmentsDir = chatAttachmentsDir(dataDir, chatId)
      const attachments: Attachment[] = request.attachments.filter((a) =>
        isInside(attachmentsDir, a.path),
      )

      if (!chats.exists(chatId)) {
        const title =
          request.prompt.trim().split('\n')[0]?.slice(0, 60) || attachments[0]?.name || 'Neuer Chat'
        chats.create({ id: chatId, title, provider, model: modelLabel })
      } else {
        chats.setModel(chatId, provider, modelLabel)
      }
      chats.addMessage({ chatId, role: 'user', text: request.prompt, attachments })

      const runtime = buildProviderRuntime({
        provider,
        settings,
        secret: this.deps.secrets.get(provider),
        baseEnv: process.env,
        configDir: join(dataDir, 'agent-config'),
        appVersion: this.deps.appVersion,
      })

      const cwd = request.cwd ?? chatWorkspace(dataDir, chatId)
      mkdirSync(cwd, { recursive: true })

      const resume = chats.getSdkSessionId(chatId)
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

      const blocks = buildPromptBlocks(request.prompt, attachments, { pdf: provider !== 'ollama' })
      const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
        yield {
          type: 'user',
          message: { role: 'user', content: blocks },
          parent_tool_use_id: null,
        }
      })()

      for await (const message of query({ prompt, options })) {
        if (message.type === 'system' && message.subtype === 'init') {
          chats.setSdkSessionId(chatId, message.session_id)
        }
        for (const event of normalizeSdkMessage(chatId, message as SdkMessageLike)) emit(event)
      }
    } catch (error) {
      if (!run.abort.signal.aborted) {
        emit({
          chatId,
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      if (run.abort.signal.aborted && !draft.error) draft.error = 'Abgebrochen.'
      if (chats.exists(chatId)) {
        chats.addMessage({
          chatId,
          role: 'assistant',
          text: draft.text,
          tools: draft.tools,
          error: draft.error,
          costUsd: draft.costUsd,
          durationMs: draft.durationMs,
        })
      }
    }
  }
}
