import type { WorkbenchApi } from '@shared/ipc'

/** Typed access to the preload bridge. */
export const api: WorkbenchApi = window.api
