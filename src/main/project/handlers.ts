import { app, type WebContents } from 'electron'
import type { z } from 'zod'
import { projectContract } from '@shared/ipc-project'
import { sendEvent } from '../ipc/register'
import { listProjectDir, readProjectFile } from './files'
import { gitCommit, gitDiff, gitStatus } from './git'
import { TerminalRunner } from './terminal'

export interface ProjectHandlerDeps {
  /** Window that receives push events (terminal output etc.). */
  getTarget: () => WebContents | undefined
}

type ProjectContract = typeof projectContract
type ProjectHandlers = {
  [C in keyof ProjectContract]: (
    input: z.infer<ProjectContract[C]['input']>,
  ) => z.infer<ProjectContract[C]['output']> | Promise<z.infer<ProjectContract[C]['output']>>
}

/** IPC handlers for the project panel; spread into registerIpcHandlers in ../index.ts. */
export function createProjectHandlers(deps: ProjectHandlerDeps): ProjectHandlers {
  const terminal = new TerminalRunner((event) => {
    const target = deps.getTarget()
    if (target) sendEvent(target, 'terminal:output', event)
  })
  app.on('will-quit', () => terminal.killAll())

  return {
    'project:list-dir': ({ projectPath, relPath }) => listProjectDir(projectPath, relPath),
    'project:read-file': ({ projectPath, relPath }) => readProjectFile(projectPath, relPath),
    'git:status': ({ projectPath }) => gitStatus(projectPath),
    'git:diff': ({ projectPath, path, staged }) => gitDiff(projectPath, { path, staged }),
    'git:commit': ({ projectPath, message, stageAll }) => gitCommit(projectPath, message, stageAll),
    'terminal:run': ({ projectPath, command }) => terminal.run(projectPath, command),
    'terminal:kill': ({ runId }) => ({ ok: terminal.kill(runId) }),
  }
}
