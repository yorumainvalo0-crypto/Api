import { z } from 'zod'
import {
  ProviderIdSchema,
  SecretStatusSchema,
  SettingsPatchSchema,
  SettingsSchema,
} from './schemas/settings'
import { AgentEventSchema, ChatRequestSchema } from './schemas/agent'

/**
 * Single source of truth for renderer -> main request/response calls.
 * Inputs are validated in the main process, outputs are typed for the renderer.
 */
export const ipcContract = {
  'app:info': {
    input: z.void(),
    output: z.object({ version: z.string(), platform: z.string(), agentSdkVersion: z.string() }),
  },
  'settings:get': { input: z.void(), output: SettingsSchema },
  'settings:update': { input: SettingsPatchSchema, output: SettingsSchema },
  'secrets:status': { input: z.void(), output: SecretStatusSchema },
  'secrets:set': {
    input: z.object({ provider: ProviderIdSchema, value: z.string() }),
    output: SecretStatusSchema,
  },
  'secrets:clear': { input: z.object({ provider: ProviderIdSchema }), output: SecretStatusSchema },
  'agent:send': { input: ChatRequestSchema, output: z.object({ accepted: z.boolean() }) },
  'agent:cancel': {
    input: z.object({ sessionId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
} as const

export type IpcContract = typeof ipcContract
export type IpcChannel = keyof IpcContract
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]['input']>
export type IpcOutput<C extends IpcChannel> = z.infer<IpcContract[C]['output']>

/** Main -> renderer push events. */
export const ipcEvents = {
  'agent:event': AgentEventSchema,
} as const

export type IpcEventName = keyof typeof ipcEvents
export type IpcEventPayload<E extends IpcEventName> = z.infer<(typeof ipcEvents)[E]>

/** Shape of the API exposed on `window.api` by the preload script. */
export interface WorkbenchApi {
  invoke<C extends IpcChannel>(channel: C, ...args: InvokeArgs<C>): Promise<IpcOutput<C>>
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEventPayload<E>) => void): () => void
}

// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- channels without input use z.void()
type InvokeArgs<C extends IpcChannel> = IpcInput<C> extends void ? [] : [input: IpcInput<C>]

export { IPC_EVENT_PREFIX, IPC_INVOKE_PREFIX } from './ipc-channels'
