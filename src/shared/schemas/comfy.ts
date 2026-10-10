import { z } from 'zod'

export const ComfyWorkflowKindSchema = z.enum(['image', '3d'])
export type ComfyWorkflowKind = z.infer<typeof ComfyWorkflowKindSchema>

/** An imported ComfyUI workflow (API format) with placeholders like {{prompt}}. */
export const ComfyWorkflowInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: ComfyWorkflowKindSchema,
  /** Placeholders found in the workflow, e.g. ["prompt", "seed", "input_image"]. */
  placeholders: z.array(z.string()),
  createdAt: z.number(),
})
export type ComfyWorkflowInfo = z.infer<typeof ComfyWorkflowInfoSchema>

export const ComfyStatusSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  checkpoints: z.array(z.string()),
})
export type ComfyStatus = z.infer<typeof ComfyStatusSchema>

/** Placeholders the app fills in when running a workflow. */
export const COMFY_PLACEHOLDERS = [
  'prompt',
  'negative',
  'seed',
  'width',
  'height',
  'input_image',
  'checkpoint',
] as const
