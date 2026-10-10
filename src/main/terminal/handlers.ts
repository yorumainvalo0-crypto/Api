import { app, type WebContents } from 'electron'
import type { z } from 'zod'
import { terminalContract } from '@shared/ipc-terminal'
import { sendEvent } from '../ipc/register'
import { TerminalService, type TerminalServiceDeps } from './service'

export interface TerminalHandlerDeps extends Omit<TerminalServiceDeps, 'emitData' | 'emitExit'> {
  /** Window that receives terminal output. */
  getTarget: () => WebContents | undefined
}

type TerminalContract = typeof terminalContract
type TerminalHandlers = {
  [C in keyof TerminalContract]: (
    input: z.infer<TerminalContract[C]['input']>,
  ) => z.infer<TerminalContract[C]['output']> | Promise<z.infer<TerminalContract[C]['output']>>
}

/** IPC handlers for interactive terminals; spread into registerIpcHandlers in ../index.ts. */
export function createTerminalHandlers(deps: TerminalHandlerDeps): TerminalHandlers {
  const { getTarget, ...serviceDeps } = deps
  const service = new TerminalService({
    ...serviceDeps,
    emitData: (event) => {
      const target = getTarget()
      if (target) sendEvent(target, 'terminal:data', event)
    },
    emitExit: (event) => {
      const target = getTarget()
      if (target) sendEvent(target, 'terminal:exit', event)
    },
  })
  // Shells belong to the window: a reload or crash of the renderer must not leave them behind.
  let watched: WebContents | undefined
  const watchTarget = () => {
    const target = getTarget()
    if (!target || target === watched) return
    watched = target
    target.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) service.killAll()
    })
    target.on('render-process-gone', () => service.killAll())
  }
  app.on('will-quit', () => void service.dispose())

  return {
    'terminal:create': (input) => {
      watchTarget()
      return service.create(input)
    },
    'terminal:write': ({ sessionId, data, binary }) => ({
      ok: service.write(sessionId, data, binary),
    }),
    'terminal:resize': ({ sessionId, cols, rows }) => ({
      ok: service.resize(sessionId, cols, rows),
    }),
    'terminal:kill': ({ sessionId }) => ({ ok: service.kill(sessionId) }),
  }
}
