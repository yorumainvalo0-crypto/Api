import type { WebContents } from 'electron'

export interface ProjectHandlerDeps {
  /** Window that receives push events (terminal output etc.). */
  getTarget: () => WebContents | undefined
}

/** IPC handlers for the project panel; spread into registerIpcHandlers in ../index.ts. */
export function createProjectHandlers(_deps: ProjectHandlerDeps) {
  return {}
}
