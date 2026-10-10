import type { z } from 'zod'

/**
 * IPC channels for the project panel (file tree, file viewer, git, terminal).
 * Merged into the main contract in ./ipc.ts.
 */
export const projectContract = {} satisfies Record<string, { input: z.ZodType; output: z.ZodType }>

/** Push events for the project panel, merged into ipcEvents in ./ipc.ts. */
export const projectEvents = {} satisfies Record<string, z.ZodType>
