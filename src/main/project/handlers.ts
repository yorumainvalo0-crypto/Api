import type { z } from 'zod'
import { projectContract } from '@shared/ipc-project'
import { listProjectDir, readProjectFile } from './files'
import { gitCommit, gitDiff, gitStatus } from './git'

type ProjectContract = typeof projectContract
type ProjectHandlers = {
  [C in keyof ProjectContract]: (
    input: z.infer<ProjectContract[C]['input']>,
  ) => z.infer<ProjectContract[C]['output']> | Promise<z.infer<ProjectContract[C]['output']>>
}

/**
 * IPC handlers for the project panel; spread into registerIpcHandlers in ../index.ts.
 * The panel's interactive terminal is served by ../terminal/handlers.ts.
 */
export function createProjectHandlers(): ProjectHandlers {
  return {
    'project:list-dir': ({ projectPath, relPath }) => listProjectDir(projectPath, relPath),
    'project:read-file': ({ projectPath, relPath }) => readProjectFile(projectPath, relPath),
    'git:status': ({ projectPath }) => gitStatus(projectPath),
    'git:diff': ({ projectPath, path, staged }) => gitDiff(projectPath, { path, staged }),
    'git:commit': ({ projectPath, message, stageAll }) => gitCommit(projectPath, message, stageAll),
  }
}
