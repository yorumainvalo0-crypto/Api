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
} from './schemas/project'

/**
 * IPC channels for the project panel (file tree, file viewer, git); its terminal uses
 * ./ipc-terminal.ts.
 * Merged into the main contract in ./ipc.ts.
 */
export const projectContract = {
  'project:list-dir': { input: ProjectFileInputSchema, output: z.array(DirEntrySchema) },
  'project:read-file': { input: ProjectFileInputSchema, output: FileContentSchema },
  'git:status': { input: z.object({ projectPath: ProjectPathSchema }), output: GitStatusSchema },
  /** Unified diff text (capped); untracked files are rendered as all-added. */
  'git:diff': { input: GitDiffInputSchema, output: z.string() },
  'git:commit': { input: GitCommitInputSchema, output: GitCommitResultSchema },
} satisfies Record<string, { input: z.ZodType; output: z.ZodType }>
