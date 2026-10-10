import { ipcMain, type WebContents } from 'electron'
import {
  IPC_EVENT_PREFIX,
  IPC_INVOKE_PREFIX,
  ipcContract,
  ipcEvents,
  type IpcChannel,
  type IpcEventName,
  type IpcEventPayload,
  type IpcOutput,
} from '@shared/ipc'
import type { z } from 'zod'

export type IpcHandlers = {
  [C in IpcChannel]: (
    input: z.infer<(typeof ipcContract)[C]['input']>,
  ) => IpcOutput<C> | Promise<IpcOutput<C>>
}

/** Registers all handlers; every input is validated against the shared contract. */
export function registerIpcHandlers(handlers: IpcHandlers): void {
  for (const channel of Object.keys(ipcContract) as IpcChannel[]) {
    const { input: schema } = ipcContract[channel]
    const handler = handlers[channel] as (input: unknown) => unknown
    ipcMain.handle(`${IPC_INVOKE_PREFIX}${channel}`, async (_event, raw: unknown) => {
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`Invalid input for ${channel}: ${parsed.error.message}`)
      }
      return handler(parsed.data)
    })
  }
}

/** Sends a validated push event to a renderer. */
export function sendEvent<E extends IpcEventName>(
  target: WebContents,
  event: E,
  payload: IpcEventPayload<E>,
): void {
  if (target.isDestroyed()) return
  target.send(`${IPC_EVENT_PREFIX}${event}`, ipcEvents[event].parse(payload))
}
