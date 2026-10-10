import { z } from 'zod'

/** Absolute path of the project folder the coding mode is bound to. */
export const ProjectPathSchema = z.string().min(1).max(4096)
/** Path relative to the project root, `''` is the root itself. Either separator is accepted. */
export const RelPathSchema = z.string().max(4096)

export const ProjectFileInputSchema = z.object({
  projectPath: ProjectPathSchema,
  relPath: RelPathSchema,
})

export const DirEntrySchema = z.object({
  name: z.string(),
  /** Relative to the project root, always with `/` separators. */
  relPath: z.string(),
  isDir: z.boolean(),
  /** Size in bytes (0 for directories). */
  size: z.number().int().nonnegative(),
})
export type DirEntry = z.infer<typeof DirEntrySchema>

export const FileContentSchema = z.object({
  /** UTF-8 text, empty for binary files. */
  content: z.string(),
  /** Full file size in bytes. */
  size: z.number().int().nonnegative(),
  /** True if only the first READ_FILE_LIMIT bytes were read. */
  truncated: z.boolean(),
  binary: z.boolean(),
})
export type FileContent = z.infer<typeof FileContentSchema>

export const GitFileStatusSchema = z.enum([
  'modified',
  'added',
  'deleted',
  'renamed',
  'untracked',
  'conflicted',
])
export type GitFileStatus = z.infer<typeof GitFileStatusSchema>

export const GitFileSchema = z.object({
  /** Relative to the repository root, `/` separators. */
  path: z.string(),
  /** Previous path for renames/copies. */
  origPath: z.string().nullable(),
  status: GitFileStatusSchema,
  /** True for the index (staged) side; a file changed in both appears twice. */
  staged: z.boolean(),
})
export type GitFile = z.infer<typeof GitFileSchema>

export const GitStatusSchema = z.object({
  /** False if the git executable could not be found. */
  gitAvailable: z.boolean(),
  isRepo: z.boolean(),
  /** Current branch, null when detached or not a repo. */
  branch: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  files: z.array(GitFileSchema),
})
export type GitStatus = z.infer<typeof GitStatusSchema>

export const GitDiffInputSchema = z.object({
  projectPath: ProjectPathSchema,
  /** Repository-relative path as reported by git:status; omitted for the whole tree. */
  path: z.string().min(1).max(4096).optional(),
  staged: z.boolean().optional(),
})

export const GitCommitInputSchema = z.object({
  projectPath: ProjectPathSchema,
  message: z.string().trim().min(1).max(10_000),
  stageAll: z.boolean(),
})

export const GitCommitResultSchema = z.object({ ok: z.boolean(), output: z.string() })
export type GitCommitResult = z.infer<typeof GitCommitResultSchema>
