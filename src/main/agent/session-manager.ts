import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  query,
  type McpSdkServerConfigWithInstance,
  type Options,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, ChatRequest, PermissionDecision } from '@shared/schemas/agent'
import type { AgentPermissionMode, Attachment, ChatSummary } from '@shared/schemas/chat'
import type { Settings } from '@shared/schemas/settings'
import { applyReplyEvent, EMPTY_REPLY, type ReplyState } from '@shared/message-parts'
import type { SecretStore } from '../storage/secret-store'
import type { ChatRepository } from '../storage/chat-repository'
import { buildPromptBlocks } from '../workspace/attachments'
import { isInside } from '../workspace/paths'
import { buildProviderRuntime } from './providers'
import { normalizeSdkMessage, type SdkMessageLike } from './normalize'
import { dangerousCommandHook, PermissionBroker } from './permissions'
import { WEB_MCP_SERVER, WEB_TOOL_NAMES } from '../web/mcp-server'

export interface SessionManagerDeps {
  getSettings: () => Settings
  secrets: SecretStore
  chats: ChatRepository
  /** Root directory for per-chat workspaces and the isolated agent config. */
  dataDir: string
  appVersion: string
  executablePath: string
  emit: (event: AgentEvent) => void
  /** Creates the in-process web tools server (one instance per run). */
  createWebServer?: () => McpSdkServerConfigWithInstance
}

interface ActiveRun {
  abort: AbortController
  query?: Query
}

const CHAT_SYSTEM_PROMPT = [
  'Du bist ein hilfreicher, präziser Assistent in der Desktop-App "AI Workbench".',
  'Antworte in der Sprache des Nutzers (meist Deutsch). Nutze Markdown für Struktur und Code.',
  'Angehängte Dateien, die nicht direkt eingebettet sind, werden mit ihrem Dateipfad genannt.',
].join('\n')

const CODE_SYSTEM_APPEND = [
  'You are running inside the "AI Workbench" desktop app on the user\'s own machine.',
  'Reply to the user in their language (usually German). Keep code, identifiers and code',
  'comments in English. The user sees your tool calls and file diffs in the app.',
].join('\n')

export function chatWorkspace(dataDir: string, chatId: string): string {
  return join(dataDir, 'chats', chatId)
}

export function chatAttachmentsDir(dataDir: string, chatId: string): string {
  return join(chatWorkspace(dataDir, chatId), 'attachments')
}

export class SessionError extends Error {
  override name = 'SessionError'
}

/** Runs Claude Agent SDK queries per chat and streams normalized events. */
export class SessionManager {
  private readonly active = new Map<string, ActiveRun>()
  private readonly permissions: PermissionBroker

  constructor(private readonly deps: SessionManagerDeps) {
    this.permissions = new PermissionBroker(deps.emit)
  }

  isRunning(chatId: string): boolean {
    return this.active.has(chatId)
  }

  /** Creates a coding chat bound to a project folder. */
  createProjectChat(args: { chatId?: string; projectPath: string }): ChatSummary {
    if (!statSync(args.projectPath, { throwIfNoEntry: false })?.isDirectory()) {
      throw new SessionError(`Projektordner nicht gefunden: ${args.projectPath}`)
    }
    const settings = this.deps.getSettings()
    const provider = settings.activeProvider
    const name = args.projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? args.projectPath
    return this.deps.chats.create({
      ...(args.chatId ? { id: args.chatId } : {}),
      title: `💻 ${name}`,
      provider,
      model: settings.models[provider] || 'Standard',
      mode: 'code',
      projectPath: args.projectPath,
      permissionMode: 'default',
    })
  }

  /** Persists the mode and applies it to a running agent immediately. */
  async setPermissionMode(chatId: string, mode: AgentPermissionMode): Promise<void> {
    this.deps.chats.setPermissionMode(chatId, mode)
    await this.active.get(chatId)?.query?.setPermissionMode(mode)
  }

  respondToPermission(requestId: string, decision: PermissionDecision, message?: string): boolean {
    return this.permissions.respond(requestId, decision, message)
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
    this.permissions.denyAll(chatId)
    if (!run) return false
    run.abort.abort()
    return true
  }

  cancelAll(): void {
    for (const chatId of this.active.keys()) this.cancel(chatId)
  }

  private async execute(request: ChatRequest, run: ActiveRun): Promise<void> {
    const { chatId } = request
    const { chats, dataDir } = this.deps
    let reply: ReplyState = EMPTY_REPLY
    const emit = (event: AgentEvent): void => {
      reply = applyReplyEvent(reply, event)
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
      const chat = chats.summary(chatId)
      if (!chat) throw new SessionError('Chat konnte nicht angelegt werden.')
      chats.addMessage({ chatId, role: 'user', text: request.prompt, attachments })

      const runtime = buildProviderRuntime({
        provider,
        settings,
        secret: this.deps.secrets.get(provider),
        baseEnv: process.env,
        configDir: join(dataDir, 'agent-config'),
        appVersion: this.deps.appVersion,
      })

      const isCode = chat.mode === 'code' && chat.projectPath !== null
      const cwd = isCode && chat.projectPath ? chat.projectPath : chatWorkspace(dataDir, chatId)
      mkdirSync(cwd, { recursive: true })

      const resume = chats.getSdkSessionId(chatId)
      const web =
        settings.webAccess && this.deps.createWebServer ? this.deps.createWebServer() : undefined
      const common: Options = {
        cwd,
        env: runtime.env,
        pathToClaudeCodeExecutable: this.deps.executablePath,
        abortController: run.abort,
        includePartialMessages: true,
        persistSession: true,
        ...(runtime.model ? { model: runtime.model } : {}),
        ...(resume ? { resume } : {}),
        ...(web ? { mcpServers: { [WEB_MCP_SERVER]: web } } : {}),
        // Our own free web tools replace the built-in ones (which need Anthropic-hosted services).
        disallowedTools: ['WebSearch', 'WebFetch'],
      }
      const options: Options = isCode
        ? {
            ...common,
            tools: { type: 'preset', preset: 'claude_code' },
            // Loads the project's CLAUDE.md and .claude/settings.json.
            settingSources: ['project'],
            systemPrompt: { type: 'preset', preset: 'claude_code', append: CODE_SYSTEM_APPEND },
            permissionMode: chat.permissionMode,
            ...(chat.permissionMode === 'bypassPermissions'
              ? { allowDangerouslySkipPermissions: true }
              : {}),
            // Reading the web is harmless, so it never needs approval.
            ...(web ? { allowedTools: WEB_TOOL_NAMES } : {}),
            canUseTool: this.permissions.canUseTool(chatId),
            hooks: { PreToolUse: [dangerousCommandHook()] },
          }
        : {
            ...common,
            tools: [],
            settingSources: [],
            systemPrompt: web
              ? `${CHAT_SYSTEM_PROMPT}\nDu hast Internetzugriff über web_search und web_fetch. Nutze ihn für aktuelle Informationen und nenne die Quellen-URLs.`
              : CHAT_SYSTEM_PROMPT,
            ...(web ? { allowedTools: WEB_TOOL_NAMES } : {}),
          }

      const blocks = buildPromptBlocks(request.prompt, attachments, { pdf: provider !== 'ollama' })
      const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
        yield {
          type: 'user',
          message: { role: 'user', content: blocks },
          parent_tool_use_id: null,
        }
      })()

      run.query = query({ prompt, options })
      for await (const message of run.query) {
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
      this.permissions.denyAll(chatId)
      if (run.abort.signal.aborted && !reply.error) reply = { ...reply, error: 'Abgebrochen.' }
      if (chats.exists(chatId)) {
        chats.addMessage({
          chatId,
          role: 'assistant',
          parts: reply.parts,
          error: reply.error,
          costUsd: reply.costUsd,
          durationMs: reply.durationMs,
        })
      }
    }
  }
}
