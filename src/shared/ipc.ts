import { z } from 'zod'
import {
  ProviderIdSchema,
  SecretStatusSchema,
  SettingsPatchSchema,
  SettingsSchema,
} from './schemas/settings'
import { AgentEventSchema, ChatRequestSchema } from './schemas/agent'
import {
  AttachmentInputSchema,
  AttachmentSchema,
  ChatDetailSchema,
  ChatSummarySchema,
} from './schemas/chat'
import { ConnectionTestResultSchema, ModelInfoSchema } from './schemas/models'
import { projectContract, projectEvents } from './ipc-project'

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
  'settings:update': { input: SettingsPatchSchema, output: SettingsSchema },
  'secrets:status': { input: z.void(), output: SecretStatusSchema },
  'secrets:set': {
    input: z.object({ provider: ProviderIdSchema, value: z.string() }),
    output: SecretStatusSchema,
  },
  'secrets:clear': { input: z.object({ provider: ProviderIdSchema }), output: SecretStatusSchema },
  'models:list': {
    input: z.object({ provider: ProviderIdSchema }),
    output: z.array(ModelInfoSchema),
  },
  'models:test': {
    input: z.object({ provider: ProviderIdSchema }),
    output: ConnectionTestResultSchema,
  },
  'chats:list': { input: z.void(), output: z.array(ChatSummarySchema) },
  'chats:get': { input: ChatIdInput, output: ChatDetailSchema.nullable() },
  'chats:rename': {
    input: ChatIdInput.extend({ title: z.string().trim().min(1).max(200) }),
    output: z.object({ ok: z.boolean() }),
  },
  'chats:delete': { input: ChatIdInput, output: z.object({ ok: z.boolean() }) },
  'attachments:add': {
    input: ChatIdInput.extend({ files: z.array(AttachmentInputSchema).min(1).max(20) }),
    output: z.object({ attachments: z.array(AttachmentSchema), errors: z.array(z.string()) }),
  },
  'dialog:open-files': { input: z.void(), output: z.array(z.string()) },
  'agent:send': { input: ChatRequestSchema, output: z.object({ accepted: z.boolean() }) },
  'agent:cancel': { input: ChatIdInput, output: z.object({ ok: z.boolean() }) },
  ...projectContract,
} as const

export type IpcContract = typeof ipcContract
export type IpcChannel = keyof IpcContract
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]['input']>
export type IpcOutput<C extends IpcChannel> = z.infer<IpcContract[C]['output']>

/** Main -> renderer push events. */
export const ipcEvents = {
  'agent:event': AgentEventSchema,
  ...projectEvents,
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
