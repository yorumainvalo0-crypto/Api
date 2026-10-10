import { mkdirSync, realpathSync, statSync } from 'node:fs'
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
import type { CoworkRole, ProviderId, Settings } from '@shared/schemas/settings'
import type { ContextUsage } from '@shared/schemas/usage'
import { applyReplyEvent, EMPTY_REPLY, type ReplyState } from '@shared/message-parts'
import type { SecretStore } from '../storage/secret-store'
import type { ChatRepository } from '../storage/chat-repository'
import { buildPromptBlocks } from '../workspace/attachments'
import { extractDocument } from '../documents/extract'
import type { UsageRepository } from '../storage/usage-repository'
import { contextFromResult, parseContextResponse } from './context'
import { describeAppCapabilities } from './app-context'
import { OPEN_CODING_SYSTEM_PROMPT } from './prompts/open-coding-prompt'
import { isClaudeModel } from './prompts/select'
import { applyRole, routeRequest } from '../cowork/router'
import { coworkBrief, SUBAGENT_NOTE } from '../cowork/brief'
import {
  COWORK_MCP_SERVER,
  COWORK_TOOL_NAMES,
  createCoworkMcpServer,
  type SubagentResult,
} from '../cowork/mcp-server'
import type { JevResponse } from '../jev/client'
import { jevClientFromSettings } from '../jev/config'
import { createJevMcpServer, JEV_MCP_SERVER, JEV_TOOL_NAMES } from '../jev/mcp-server'
import {
  fromSdkModelUsage,
  sumTotals,
  usageDelta,
  type ModelTotals,
  type UsageSnapshot,
} from './usage'
import { isInside } from '../workspace/paths'
import { buildProviderRuntime } from './providers'
import { normalizeSdkMessage, type SdkMessageLike } from './normalize'
import { dangerousCommandHook, PermissionBroker } from './permissions'
import { WEB_MCP_SERVER, WEB_TOOL_NAMES } from '../web/mcp-server'
import { createMediaMcpServer, MEDIA_MCP_SERVER, MEDIA_TOOL_NAMES } from '../media/mcp-server'
import { outputsDir } from '../media/outputs'
import type { AgentAddonConfig } from '../addons/addon-store'
import type { ComfyConfig } from '../media/comfy-generate'
import type { ComfyWorkflowStore } from '../media/comfy-workflows'
import { OllamaVision } from '../media/ocr'

export interface SessionManagerDeps {
  getSettings: () => Settings
  secrets: SecretStore
  chats: ChatRepository
  /** Test hooks for the Jev decision tool. */
  jevEndpoint?: string
  jevFetch?: typeof fetch
  /** Token/cost log for the usage view; without it costs are still computed per answer. */
  usage?: UsageRepository
  /** Root directory for per-chat workspaces and the isolated agent config. */
  dataDir: string
  appVersion: string
  executablePath: string
  emit: (event: AgentEvent) => void
  /** Creates the in-process web tools server (one instance per run). */
  createWebServer?: () => McpSdkServerConfigWithInstance
  /** fetch used for image generation (tests inject a fake OpenRouter). */
  mediaFetch?: typeof fetch
  /** Enabled skills, plugins and MCP servers. */
  getAddons?: () => AgentAddonConfig
  /** Imported ComfyUI workflows (enables local image/3D generation). */
  comfyWorkflows?: ComfyWorkflowStore
  /** fetch used for ComfyUI (tests inject a fake server). */
  comfyFetch?: typeof fetch
  /** fetch used for local OCR via Ollama (tests inject a fake server). */
  ocrFetch?: typeof fetch
}

interface ActiveRun {
  abort: AbortController
  query?: Query
}

const CHAT_SYSTEM_PROMPT = [
  'Du bist ein hilfreicher, präziser Assistent in der Desktop-App "AI Workbench".',
  'Antworte in der Sprache des Nutzers (meist Deutsch). Nutze Markdown für Struktur und Code.',
  'Angehängte Dateien, die nicht direkt eingebettet sind, werden mit ihrem Dateipfad genannt.',
  'Ist das Internet aktiv, nutze es bei aktuellen Themen und nenne die Quellen-URLs.',
].join('\n')

const CODE_SYSTEM_APPEND = [
  'You are running inside the "AI Workbench" desktop app on the user\'s own machine.',
  'Reply to the user in their language (usually German). Keep code, identifiers and code',
  'comments in English. The user sees your tool calls and file diffs in the app.',
  'Files created with the mcp__media__ tools are saved to ./ai-output and shown to the user.',
].join('\n')

/** Converts attached office files to Markdown so every model (also local ones) can read them. */
async function extractAttachedDocuments(attachments: Attachment[]): Promise<Map<string, string>> {
  const documents = new Map<string, string>()
  for (const a of attachments) {
    if (a.kind !== 'document') continue
    try {
      const doc = await extractDocument(a.path)
      documents.set(
        a.path,
        `${doc.summary}${doc.truncated ? ' (gekürzt – mit read_document und max_chars mehr lesen)' : ''}\n\n${doc.markdown}`,
      )
    } catch (error) {
      documents.set(
        a.path,
        `[Konnte nicht gelesen werden: ${error instanceof Error ? error.message : String(error)}]`,
      )
    }
  }
  return documents
}

/** Asks the runtime how full the context window is (summary mode, no extra API calls). */
async function readContextUsage(q: Query): Promise<ContextUsage | undefined> {
  try {
    const response = await Promise.race([
      q.getContextUsage({ detail: 'summary' }),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
    ])
    return parseContextResponse(response)
  } catch {
    return undefined
  }
}

/** The SDK effort option; local Ollama models do not understand the effort parameter. */
export function effortOption(
  settings: Pick<Settings, 'effort'>,
  provider: ProviderId,
): { effort?: Exclude<Settings['effort'], 'default'> } {
  return settings.effort !== 'default' && provider !== 'ollama' ? { effort: settings.effort } : {}
}

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
  /** Fallback when no usage repository is configured (tests). */
  private readonly snapshots = new Map<string, UsageSnapshot>()

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
    // Canonical long path: Windows 8.3 short names (e.g. RUNNER~1) would otherwise make the agent
    // treat files in the project as outside its working directory.
    const projectPath = realpathSync.native(args.projectPath)
    const settings = this.deps.getSettings()
    const provider = settings.activeProvider
    const name = projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath
    return this.deps.chats.create({
      ...(args.chatId ? { id: args.chatId } : {}),
      title: `💻 ${name}`,
      provider,
      model: settings.models[provider] || 'Standard',
      mode: 'code',
      projectPath,
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

  /**
   * Logs the tokens and cost of one answer (difference to the session's previous totals) and
   * returns its cost in USD, or undefined when the SDK reported no usage.
   */
  private recordUsage(
    chatId: string,
    provider: ProviderId,
    sessionId: string,
    modelUsage: Parameters<typeof fromSdkModelUsage>[0],
  ): number | undefined {
    const current = fromSdkModelUsage(modelUsage)
    if (Object.keys(current).length === 0) return undefined
    const usage = this.deps.usage
    const previous = usage ? usage.getSnapshot(chatId) : this.snapshots.get(chatId)
    const snapshot = { sessionId, models: current }
    if (usage) usage.setSnapshot(chatId, snapshot)
    else this.snapshots.set(chatId, snapshot)

    const delta = usageDelta(previous, sessionId, current)
    // Local models are free; the SDK would price them like hosted ones.
    const models: Record<string, ModelTotals> =
      provider === 'ollama'
        ? Object.fromEntries(Object.entries(delta).map(([m, t]) => [m, { ...t, costUsd: 0 }]))
        : delta
    if (Object.keys(models).length > 0) usage?.record({ chatId, provider, models })
    return sumTotals(models).costUsd
  }

  /** Logs a Jev call (router or tool); returns its cost in USD (0 when unknown). */
  private recordJevUsage(
    chatId: string,
    agent: string,
    source: Settings['jevSource'],
    model: string,
    usage: NonNullable<JevResponse['usage']>,
  ): number {
    const costUsd = usage.cost ?? 0
    this.deps.usage?.record({
      chatId,
      agent,
      provider: source === 'typesafe' ? 'typesafe' : 'openrouter',
      models: {
        [model]: {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd,
        },
      },
    })
    return costUsd
  }

  /**
   * Runs one Cowork subagent as its own query with the role's provider, model and effort.
   * Its usage is logged separately (agent "subagent:<role>") and returned to the coordinator.
   */
  private async runSubagent(args: {
    chatId: string
    run: ActiveRun
    role: CoworkRole
    prompt: string
    baseSettings: Settings
    buildOptions: (env: Record<string, string | undefined>, settings: Settings) => Options
  }): Promise<SubagentResult> {
    const { chatId, role } = args
    const settings = applyRole(args.baseSettings, role)
    const runtime = buildProviderRuntime({
      provider: role.provider,
      settings,
      secret: this.deps.secrets.get(role.provider),
      baseEnv: process.env,
      configDir: join(this.deps.dataDir, 'agent-config'),
      appVersion: this.deps.appVersion,
    })
    const abort = new AbortController()
    const stop = () => abort.abort()
    args.run.abort.signal.addEventListener('abort', stop, { once: true })
    try {
      const options: Options = {
        ...args.buildOptions(runtime.env, settings),
        abortController: abort,
        ...(runtime.model ? { model: runtime.model } : {}),
      }
      let text = ''
      let isError = false
      let model = role.model || 'Standard'
      let costUsd = 0
      for await (const message of query({ prompt: args.prompt, options })) {
        if (message.type === 'system' && message.subtype === 'init') model = message.model
        if (message.type !== 'result') continue
        isError = message.is_error || message.subtype !== 'success'
        text =
          message.subtype === 'success'
            ? message.result
            : message.errors.join('\n') || 'Der Subagent wurde ohne Ergebnis beendet.'
        const totals = fromSdkModelUsage(message.modelUsage)
        const models: Record<string, ModelTotals> =
          role.provider === 'ollama'
            ? Object.fromEntries(Object.entries(totals).map(([m, t]) => [m, { ...t, costUsd: 0 }]))
            : totals
        if (Object.keys(models).length > 0) {
          this.deps.usage?.record({
            chatId,
            provider: role.provider,
            models,
            agent: `subagent:${role.name}`,
          })
        }
        costUsd = sumTotals(models).costUsd
      }
      return { text: text || '[Keine Antwort]', model, costUsd, isError }
    } finally {
      args.run.abort.signal.removeEventListener('abort', stop)
    }
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

    let endInput = () => {}
    const inputDone = new Promise<void>((resolve) => (endInput = resolve))
    // Costs of the router, the Jev tool and subagents; added to the answer's cost.
    let extraCostUsd = 0
    try {
      const baseSettings = this.deps.getSettings()
      const jevSetup = baseSettings.jevEnabled
        ? jevClientFromSettings(baseSettings, this.deps.secrets, {
            endpoint: this.deps.jevEndpoint,
            fetchImpl: this.deps.jevFetch,
          })
        : undefined
      const jevClient = jevSetup && 'client' in jevSetup ? jevSetup.client : undefined
      const recordJev = (agent: string, usage: NonNullable<JevResponse['usage']>) => {
        if (!jevClient) return
        extraCostUsd += this.recordJevUsage(
          chatId,
          agent,
          baseSettings.jevSource,
          jevClient.model,
          usage,
        )
      }

      // Cowork: Jev picks the role (provider, model, effort) for this request.
      const route = baseSettings.coworkEnabled
        ? await routeRequest({
            prompt: request.prompt,
            attachmentNames: request.attachments.map((a) => a.name),
            mode: chats.summary(chatId)?.mode === 'code' ? 'code' : 'chat',
            roles: baseSettings.coworkRoles,
            defaultRoleId: baseSettings.coworkDefaultRole,
            jev: jevClient,
            subagents: baseSettings.coworkSubagents,
          })
        : undefined
      if (route?.usage) recordJev('router', route.usage)
      const settings = route ? applyRole(baseSettings, route.role) : baseSettings
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
      if (route) {
        emit({
          chatId,
          type: 'route',
          route: {
            roleId: route.role.id,
            roleName: route.role.name,
            provider: route.role.provider,
            model: route.role.model,
            effort: route.role.effort,
            by: route.by,
            confidence: route.confidence,
            splitProbability: route.splitProbability,
            note: route.note,
          },
        })
      }

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
      // MCP server instances cannot be shared between queries, so subagents get fresh ones.
      const makeWeb = () =>
        settings.webAccess && this.deps.createWebServer ? this.deps.createWebServer() : undefined
      const web = makeWeb()
      const store = this.deps.comfyWorkflows
      const comfyConfig = store
        ? (): ComfyConfig => {
            const current = this.deps.getSettings()
            return {
              url: current.comfyUrl,
              checkpoint: current.comfyCheckpoint,
              imageWorkflowId: current.comfyImageWorkflow,
              resolution: current.comfyResolution,
              store,
              ...(this.deps.comfyFetch
                ? { fetchImpl: this.deps.comfyFetch, pollIntervalMs: 10 }
                : {}),
            }
          }
        : undefined
      const makeMedia = () =>
        createMediaMcpServer({
          outputsDir: outputsDir(dataDir, chat),
          readableRoots: [
            chatWorkspace(dataDir, chatId),
            ...(chat.projectPath ? [chat.projectPath] : []),
          ],
          getImageConfig: () => {
            const current = this.deps.getSettings()
            return current.imageBackend === 'comfyui' && comfyConfig
              ? { backend: 'comfyui', comfy: comfyConfig() }
              : {
                  backend: 'openrouter',
                  apiKey: this.deps.secrets.get('openrouter'),
                  model: current.imageModel,
                }
          },
          ...(comfyConfig ? { getComfyConfig: comfyConfig } : {}),
          ...(settings.ocrEnabled
            ? {
                ocr: {
                  vision: new OllamaVision({
                    baseUrl: settings.ocrBaseUrl || settings.ollamaBaseUrl,
                    ...(this.deps.ocrFetch ? { fetchImpl: this.deps.ocrFetch } : {}),
                  }),
                  model: settings.ocrModel,
                  keepAliveSec: settings.ocrKeepAliveSec,
                },
              }
            : {}),
          onFile: (file) => emit({ chatId, type: 'output-file', file }),
          ...(this.deps.mediaFetch ? { fetchImpl: this.deps.mediaFetch } : {}),
        })
      const makeJev = () =>
        jevClient ? createJevMcpServer(jevClient, (usage) => recordJev('jev', usage)) : undefined
      const jev = makeJev()
      const addons = this.deps.getAddons?.() ?? { mcpServers: {}, plugins: [], skills: [] }
      const capabilities = (mode: 'chat' | 'code') =>
        describeAppCapabilities({
          mode,
          provider,
          model: modelLabel,
          effort: provider === 'ollama' ? 'default' : settings.effort,
          webAccess: Boolean(web),
          image:
            settings.imageBackend === 'comfyui' && comfyConfig
              ? { backend: 'comfyui', url: settings.comfyUrl }
              : {
                  backend: 'openrouter',
                  ready: Boolean(this.deps.secrets.get('openrouter')),
                  model: settings.imageModel,
                },
          workflows3d: (store?.list() ?? []).filter((w) => w.kind === '3d').map((w) => w.name),
          ocr: { enabled: settings.ocrEnabled, model: settings.ocrModel },
          jev:
            jev && jevSetup && 'client' in jevSetup
              ? { active: true, source: settings.jevSource }
              : {
                  active: false,
                  reason:
                    jevSetup && 'reason' in jevSetup
                      ? jevSetup.reason
                      : 'In den Einstellungen ausgeschaltet.',
                },
          skills: addons.skills,
          plugins: addons.plugins.length,
          mcpServers: Object.keys(addons.mcpServers),
        })
      // Tools that only read the web, create files, ask Jev or load skills never need approval.
      const autoAllowed = [
        ...(web ? WEB_TOOL_NAMES : []),
        ...MEDIA_TOOL_NAMES,
        ...(jev ? JEV_TOOL_NAMES : []),
        'Skill',
      ]
      const sharedServers = () => {
        const subWeb = makeWeb()
        const subJev = makeJev()
        return {
          ...addons.mcpServers,
          [MEDIA_MCP_SERVER]: makeMedia(),
          ...(subWeb ? { [WEB_MCP_SERVER]: subWeb } : {}),
          ...(subJev ? { [JEV_MCP_SERVER]: subJev } : {}),
        }
      }
      // Options shared by the main agent and subagents for the chat/coding mode.
      const modeOptions = (
        systemNote: string,
        agentProvider: ProviderId,
        agentModel: string,
      ): Partial<Options> =>
        isCode
          ? {
              tools: { type: 'preset', preset: 'claude_code' },
              // user = installed skills (isolated config dir); project = CLAUDE.md, .claude/settings.json.
              settingSources: ['user', 'project'],
              skills: 'all',
              // Claude keeps the Claude Code prompt; other models get the open-source Codex prompt.
              systemPrompt: isClaudeModel(agentProvider, agentModel)
                ? {
                    type: 'preset',
                    preset: 'claude_code',
                    append: `${CODE_SYSTEM_APPEND}\n\n${systemNote}`,
                  }
                : `${OPEN_CODING_SYSTEM_PROMPT}\n\n${systemNote}`,
              permissionMode: chat.permissionMode,
              ...(chat.permissionMode === 'bypassPermissions'
                ? { allowDangerouslySkipPermissions: true }
                : {}),
              hooks: { PreToolUse: [dangerousCommandHook()] },
            }
          : {
              // No built-in file/shell tools in chat mode; installed skills stay available.
              tools: addons.skills.length > 0 ? ['Skill'] : [],
              settingSources: addons.skills.length > 0 ? ['user'] : [],
              ...(addons.skills.length > 0 ? { skills: addons.skills } : {}),
              permissionMode: 'default',
              systemPrompt: `${CHAT_SYSTEM_PROMPT}\n\n${systemNote}`,
            }

      const cowork =
        route && baseSettings.coworkSubagents
          ? createCoworkMcpServer({
              roles: baseSettings.coworkRoles,
              parallelSafe: !isCode,
              runSubagent: async ({ role, task, context }) => {
                const result = await this.runSubagent({
                  chatId,
                  run,
                  role,
                  prompt: context ? `${task}\n\n<context>\n${context}\n</context>` : task,
                  baseSettings,
                  buildOptions: (env, subSettings) => ({
                    cwd,
                    env,
                    pathToClaudeCodeExecutable: this.deps.executablePath,
                    persistSession: false,
                    mcpServers: sharedServers(),
                    plugins: addons.plugins,
                    allowedTools: autoAllowed,
                    ...(subSettings.maxBudgetUsd > 0
                      ? { maxBudgetUsd: subSettings.maxBudgetUsd }
                      : {}),
                    ...effortOption(subSettings, role.provider),
                    canUseTool: this.permissions.canUseTool(chatId),
                    disallowedTools: ['WebSearch', 'WebFetch'],
                    ...modeOptions(
                      `${SUBAGENT_NOTE}\n\n${capabilities(isCode ? 'code' : 'chat')}`,
                      role.provider,
                      role.model,
                    ),
                  }),
                })
                extraCostUsd += result.costUsd
                return result
              },
            })
          : undefined
      const mainNote = [
        route ? coworkBrief(route, baseSettings.coworkRoles, Boolean(cowork)) : '',
        capabilities(isCode ? 'code' : 'chat'),
      ]
        .filter(Boolean)
        .join('\n\n')
      const common: Options = {
        cwd,
        env: runtime.env,
        pathToClaudeCodeExecutable: this.deps.executablePath,
        abortController: run.abort,
        includePartialMessages: true,
        persistSession: true,
        ...(runtime.model ? { model: runtime.model } : {}),
        ...(resume ? { resume } : {}),
        mcpServers: {
          ...addons.mcpServers,
          [MEDIA_MCP_SERVER]: makeMedia(),
          ...(web ? { [WEB_MCP_SERVER]: web } : {}),
          ...(jev ? { [JEV_MCP_SERVER]: jev } : {}),
          ...(cowork ? { [COWORK_MCP_SERVER]: cowork } : {}),
        },
        plugins: addons.plugins,
        allowedTools: [...autoAllowed, ...(cowork ? COWORK_TOOL_NAMES : [])],
        ...(settings.maxBudgetUsd > 0 ? { maxBudgetUsd: settings.maxBudgetUsd } : {}),
        ...effortOption(settings, provider),
        // Tools from user-installed MCP servers and plugins ask for approval.
        canUseTool: this.permissions.canUseTool(chatId),
        // Our own free web tools replace the built-in ones (which need Anthropic-hosted services).
        disallowedTools: ['WebSearch', 'WebFetch'],
      }
      const options: Options = {
        ...common,
        ...modeOptions(mainNote, provider, settings.models[provider]),
      }

      const documents = await extractAttachedDocuments(attachments)
      const blocks = buildPromptBlocks(
        request.prompt,
        attachments,
        { pdf: provider !== 'ollama' },
        documents,
      )
      // The input stays open until the context usage was read after the answer; the runtime
      // shuts down as soon as its input ends.
      const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
        yield {
          type: 'user',
          message: { role: 'user', content: blocks },
          parent_tool_use_id: null,
        }
        await inputDone
      })()

      run.query = query({ prompt, options })
      let sessionId = resume ?? ''
      let model = ''
      for await (const message of run.query) {
        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = message.session_id
          model = message.model
          chats.setSdkSessionId(chatId, message.session_id)
        }
        const cost =
          message.type === 'result'
            ? this.recordUsage(chatId, provider, sessionId, message.modelUsage)
            : undefined
        for (const event of normalizeSdkMessage(chatId, message as SdkMessageLike)) {
          // The SDK reports session totals; show and store what this answer cost.
          emit(
            event.type === 'result' && cost !== undefined
              ? { ...event, costUsd: cost + extraCostUsd }
              : event,
          )
        }
        if (message.type === 'result') {
          const context =
            (await readContextUsage(run.query)) ??
            contextFromResult(message.usage, message.modelUsage, model)
          endInput()
          if (context) {
            this.deps.usage?.setContext(chatId, context)
            emit({ chatId, type: 'context', context })
          }
        }
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
      endInput()
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
