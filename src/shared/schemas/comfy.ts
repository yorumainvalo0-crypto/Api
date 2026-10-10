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
  /** True when the placeholders were detected automatically from a plain export. */
  autoDetected: z.boolean().default(false),
  createdAt: z.number(),
})
export type ComfyWorkflowInfo = z.infer<typeof ComfyWorkflowInfoSchema>

/** An image model found in ComfyUI: a checkpoint or a split-file diffusion model. */
export const ComfyModelInfoSchema = z.object({
  name: z.string(),
  kind: z.enum(['checkpoint', 'diffusion']),
  /** Recognized split-file family (z-image, flux-dev, …); null = unknown or checkpoint. */
  family: z.string().nullable(),
  familyLabel: z.string().nullable(),
  /** Companion files a split-file model still needs (empty = ready). */
  missing: z.array(z.string()),
})
export type ComfyModelInfo = z.infer<typeof ComfyModelInfoSchema>

export const ComfyStatusSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  checkpoints: z.array(z.string()),
  models: z.array(ComfyModelInfoSchema),
  /** Other ComfyUI addresses found on this PC when the configured one is not reachable. */
  suggestions: z.array(z.string()),
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
