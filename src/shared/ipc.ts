import { z } from 'zod'
import {
  ProviderIdSchema,
  SecretIdSchema,
  SecretStatusSchema,
  SettingsPatchSchema,
  SettingsSchema,
} from './schemas/settings'
import { AgentEventSchema, ChatRequestSchema, PermissionDecisionSchema } from './schemas/agent'
import {
  AgentPermissionModeSchema,
  AttachmentInputSchema,
  AttachmentSchema,
  ChatDetailSchema,
  ChatSummarySchema,
} from './schemas/chat'
import { ConnectionTestResultSchema, ModelInfoSchema } from './schemas/models'
import { projectContract } from './ipc-project'
import { terminalContract, terminalEvents } from './ipc-terminal'
import { addonsContract } from './ipc-addons'
import { OutputFileSchema } from './schemas/media'
import { UpdateStatusSchema } from './schemas/updates'
import { ContextUsageSchema, UsageRangeSchema, UsageSummarySchema } from './schemas/usage'
import {
  ComfyStatusSchema,
  ComfyWorkflowInfoSchema,
  ComfyWorkflowKindSchema,
} from './schemas/comfy'

const ChatIdInput = z.object({ chatId: z.string().min(1) })

/**
 * Single source of truth for renderer -> main request/response calls.
 * Inputs are validated in the main process, outputs are typed for the renderer.
 */
export const ipcContract = {
  'app:info': {
    input: z.void(),
    output: z.object({
      version: z.string(),
      platform: z.string(),
      agentSdkVersion: z.string(),
      dataDir: z.string(),
    }),
  },
  'settings:get': { input: z.void(), output: SettingsSchema },
  'updates:check': { input: z.void(), output: UpdateStatusSchema },
  /** Current updater state without starting a new check. */
  'updates:status': { input: z.void(), output: UpdateStatusSchema },
  'updates:install': { input: z.void(), output: z.object({ ok: z.boolean() }) },
  /** Tests the ComfyUI connection (current settings) and lists installed checkpoints. */
  'comfy:status': { input: z.void(), output: ComfyStatusSchema },
  'comfy:workflows': { input: z.void(), output: z.array(ComfyWorkflowInfoSchema) },
  /** Opens a file picker for an API-format workflow JSON and imports it. */
  'comfy:workflow-import': {
    input: z.object({ name: z.string().min(1).max(80), kind: ComfyWorkflowKindSchema }),
    output: ComfyWorkflowInfoSchema.nullable(),
  },
  'comfy:workflow-remove': {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  /** Finds running Ollama/ComfyUI servers on this PC (also when started from Pinokio). */
  'local:discover': {
    input: z.void(),
    output: z.object({
      ollama: z.array(z.object({ url: z.string(), version: z.string() })),
      comfy: z.array(z.object({ url: z.string(), version: z.string() })),
    }),
  },
  'ocr:status': {
    input: z.void(),
    output: z.object({
      reachable: z.boolean(),
      version: z.string().nullable(),
      installed: z.boolean(),
      message: z.string(),
      baseUrl: z.string(),
      model: z.string(),
    }),
  },
  /** Starts downloading the OCR model; progress arrives as 'ocr:progress' events. */
  'ocr:download': { input: z.void(), output: z.object({ started: z.boolean() }) },
  'ocr:remove': { input: z.void(), output: z.object({ ok: z.boolean() }) },
  /** Transcribes an image locally (handwriting or document layout). */
  'ocr:recognize': {
    input: z.object({
      path: z.string().min(1),
      mode: z.enum(['handwriting', 'document']).optional(),
    }),
    output: z.object({ text: z.string() }),
  },
  'settings:update': { input: SettingsPatchSchema, output: SettingsSchema },
  'secrets:status': { input: z.void(), output: SecretStatusSchema },
  'secrets:set': {
    input: z.object({ provider: SecretIdSchema, value: z.string() }),
    output: SecretStatusSchema,
  },
  'secrets:clear': { input: z.object({ provider: SecretIdSchema }), output: SecretStatusSchema },
  'jev:test': {
    input: z.void(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  'models:list': {
    input: z.object({ provider: ProviderIdSchema }),
    output: z.array(ModelInfoSchema),
  },
  'models:test': {
    input: z.object({ provider: ProviderIdSchema }),
    output: ConnectionTestResultSchema,
  },
  'chats:list': { input: z.void(), output: z.array(ChatSummarySchema) },
  'usage:context': { input: ChatIdInput, output: ContextUsageSchema.nullable() },
  'usage:summary': {
    input: z.object({ range: UsageRangeSchema }),
    output: UsageSummarySchema,
  },
  'chats:get': { input: ChatIdInput, output: ChatDetailSchema.nullable() },
  'chats:rename': {
    input: ChatIdInput.extend({ title: z.string().trim().min(1).max(200) }),
    output: z.object({ ok: z.boolean() }),
  },
  'chats:delete': { input: ChatIdInput, output: z.object({ ok: z.boolean() }) },
  /** Saves one chat as Markdown or JSON via a save dialog. */
  'chats:export': {
    input: ChatIdInput.extend({ format: z.enum(['md', 'json']) }),
    output: z.object({ savedTo: z.string().nullable() }),
  },
  /** Saves a JSON backup of all chats via a save dialog. */
  'chats:backup': { input: z.void(), output: z.object({ savedTo: z.string().nullable() }) },
  'chats:create-project': {
    input: z.object({ chatId: z.string().min(1).optional(), projectPath: z.string().min(1) }),
    output: ChatSummarySchema,
  },
  'chats:set-permission-mode': {
    input: ChatIdInput.extend({ mode: AgentPermissionModeSchema }),
    output: z.object({ ok: z.boolean() }),
  },
  'attachments:add': {
    input: ChatIdInput.extend({ files: z.array(AttachmentInputSchema).min(1).max(20) }),
    output: z.object({ attachments: z.array(AttachmentSchema), errors: z.array(z.string()) }),
  },
  'dialog:open-files': { input: z.void(), output: z.array(z.string()) },
  /** Files the agent produced in a chat (images, 3D models, documents), newest first. */
  'outputs:list': { input: ChatIdInput, output: z.array(OutputFileSchema) },
  /** Office document converted to Markdown for the in-app preview. */
  'documents:preview': {
    input: z.object({ path: z.string().min(1) }),
    output: z.object({
      kind: z.string(),
      summary: z.string(),
      markdown: z.string(),
      truncated: z.boolean(),
    }),
  },
  'files:save-as': {
    input: z.object({ path: z.string().min(1) }),
    output: z.object({ savedTo: z.string().nullable() }),
  },
  'files:show-in-folder': {
    input: z.object({ path: z.string().min(1) }),
    output: z.object({ ok: z.boolean() }),
  },
  'files:open-external': {
    input: z.object({ path: z.string().min(1) }),
    output: z.object({ ok: z.boolean() }),
  },
  'dialog:open-folder': { input: z.void(), output: z.string().nullable() },
  'agent:send': { input: ChatRequestSchema, output: z.object({ accepted: z.boolean() }) },
  'agent:cancel': { input: ChatIdInput, output: z.object({ ok: z.boolean() }) },
  'agent:permission-respond': {
    input: z.object({
      requestId: z.string().min(1),
      decision: PermissionDecisionSchema,
      message: z.string().max(2000).optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  ...projectContract,
  ...terminalContract,
  ...addonsContract,
} as const

export type IpcContract = typeof ipcContract
export type IpcChannel = keyof IpcContract
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]['input']>
export type IpcOutput<C extends IpcChannel> = z.infer<IpcContract[C]['output']>

/** Main -> renderer push events. */
export const ipcEvents = {
  'agent:event': AgentEventSchema,
  /** Every updater change: checking, download progress, ready to install, errors. */
  'updates:changed': UpdateStatusSchema,
  'ocr:progress': z.object({
    status: z.string(),
    completed: z.number(),
    total: z.number(),
    done: z.boolean(),
    error: z.string().nullable(),
  }),
  ...terminalEvents,
} as const

export type IpcEventName = keyof typeof ipcEvents
export type IpcEventPayload<E extends IpcEventName> = z.infer<(typeof ipcEvents)[E]>

/** Shape of the API exposed on `window.api` by the preload script. */
export interface WorkbenchApi {
  invoke<C extends IpcChannel>(channel: C, ...args: InvokeArgs<C>): Promise<IpcOutput<C>>
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEventPayload<E>) => void): () => void
  /** Absolute path of a dropped/picked File (empty for in-memory data such as pasted images). */
  getPathForFile(file: File): string
}

// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- channels without input use z.void()
type InvokeArgs<C extends IpcChannel> = IpcInput<C> extends void ? [] : [input: IpcInput<C>]

export { IPC_EVENT_PREFIX, IPC_INVOKE_PREFIX } from './ipc-channels'

/** Custom protocol that serves files from the app data directory to the renderer. */
export const FILE_PROTOCOL = 'aiw-file'

export function fileUrl(absolutePath: string): string {
  return `${FILE_PROTOCOL}://local/${encodeURIComponent(absolutePath)}`
}
