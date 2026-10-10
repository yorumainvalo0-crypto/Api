import { z } from 'zod'
import {
  TerminalCreatedSchema,
  TerminalCreateInputSchema,
  TerminalDataEventSchema,
  TerminalExitEventSchema,
  TerminalResizeInputSchema,
  TerminalSessionIdSchema,
  TerminalWriteInputSchema,
} from './schemas/terminal'

const Ok = z.object({ ok: z.boolean() })

/**
 * IPC channels for interactive terminals (PTY), used by the project panel and the terminal view.
 * Merged into the main contract in ./ipc.ts.
 */
export const terminalContract = {
  /** Starts a shell (PowerShell on Windows, $SHELL elsewhere) with `claude` on PATH. */
  'terminal:create': { input: TerminalCreateInputSchema, output: TerminalCreatedSchema },
  'terminal:write': { input: TerminalWriteInputSchema, output: Ok },
  'terminal:resize': { input: TerminalResizeInputSchema, output: Ok },
  'terminal:kill': { input: z.object({ sessionId: TerminalSessionIdSchema }), output: Ok },
} satisfies Record<string, { input: z.ZodType; output: z.ZodType }>

/** Push events for terminals, merged into ipcEvents in ./ipc.ts. */
export const terminalEvents = {
  /** Batched shell output. */
  'terminal:data': TerminalDataEventSchema,
  'terminal:exit': TerminalExitEventSchema,
} satisfies Record<string, z.ZodType>
