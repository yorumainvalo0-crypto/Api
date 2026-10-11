import { z } from 'zod'
import { AgentPermissionModeSchema } from './permissions'

/** Chosen by the renderer, so output that arrives before terminal:create returns is not lost. */
export const TerminalSessionIdSchema = z.uuid()

const ColsSchema = z.number().int().min(2).max(1000)
const RowsSchema = z.number().int().min(1).max(500)

export const TerminalCreateInputSchema = z.object({
  sessionId: TerminalSessionIdSchema,
  /** Working directory; the user's home folder when omitted. */
  cwd: z.string().min(1).max(4096).optional(),
  cols: ColsSchema,
  rows: RowsSchema,
})

export const TerminalCreatedSchema = z.object({
  sessionId: z.string(),
  /** Absolute working directory the shell was started in. */
  cwd: z.string(),
  /** Shell executable, e.g. `powershell.exe` or `/bin/bash`. */
  shell: z.string(),
  /** Why `claude` cannot use the app's credentials (missing key, no model), otherwise null. */
  notice: z.string().nullable(),
  /** How `claude` starts in this session. */
  claude: z.object({
    /** Permission mode passed to `claude` (after fallbacks). */
    permissionMode: AgentPermissionModeSchema,
    /** Why the mode from the settings is replaced, otherwise null. */
    modeNote: z.string().nullable(),
    /** Folder file access is confined to; null when the confinement is switched off. */
    workFolder: z.string().nullable(),
    /** Shell commands run in the OS sandbox (only with a work folder). */
    sandbox: z.boolean(),
    sandboxSummary: z.string(),
  }),
})
export type TerminalCreated = z.infer<typeof TerminalCreatedSchema>

export const TerminalWriteInputSchema = z.object({
  sessionId: TerminalSessionIdSchema,
  data: z.string().max(1_000_000),
  /** Raw bytes encoded as latin1 (xterm's onBinary, e.g. some mouse reports). */
  binary: z.boolean().optional(),
})

export const TerminalResizeInputSchema = z.object({
  sessionId: TerminalSessionIdSchema,
  cols: ColsSchema,
  rows: RowsSchema,
})

export const TerminalDataEventSchema = z.object({ sessionId: z.string(), data: z.string() })
export type TerminalDataEvent = z.infer<typeof TerminalDataEventSchema>

export const TerminalExitEventSchema = z.object({
  sessionId: z.string(),
  exitCode: z.number().int().nullable(),
  /** POSIX signal number that ended the shell, null otherwise. */
  signal: z.number().int().nullable(),
})
export type TerminalExitEvent = z.infer<typeof TerminalExitEventSchema>
