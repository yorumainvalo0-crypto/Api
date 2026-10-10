import { z } from 'zod'
import {
  DirEntrySchema,
  FileContentSchema,
  GitCommitInputSchema,
  GitCommitResultSchema,
  GitDiffInputSchema,
  GitStatusSchema,
  ProjectFileInputSchema,
  ProjectPathSchema,
  TerminalOutputSchema,
  TerminalRunInputSchema,
} from './schemas/project'

/**
 * IPC channels for the project panel (file tree, file viewer, git, terminal).
 * Merged into the main contract in ./ipc.ts.
 */
export const projectContract = {
  'project:list-dir': { input: ProjectFileInputSchema, output: z.array(DirEntrySchema) },
  'project:read-file': { input: ProjectFileInputSchema, output: FileContentSchema },
  'git:status': { input: z.object({ projectPath: ProjectPathSchema }), output: GitStatusSchema },
  /** Unified diff text (capped); untracked files are rendered as all-added. */
  'git:diff': { input: GitDiffInputSchema, output: z.string() },
  'git:commit': { input: GitCommitInputSchema, output: GitCommitResultSchema },
  'terminal:run': { input: TerminalRunInputSchema, output: z.object({ runId: z.string() }) },
  'terminal:kill': {
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({ ok: z.boolean() }),
  },
} satisfies Record<string, { input: z.ZodType; output: z.ZodType }>

/** Push events for the project panel, merged into ipcEvents in ./ipc.ts. */
export const projectEvents = {
  'terminal:output': TerminalOutputSchema,
} satisfies Record<string, z.ZodType>
