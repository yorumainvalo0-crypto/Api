import { z } from 'zod'
import { AttachmentKindSchema } from './chat'

/** A file the agent produced (generated image, 3D model, document …). */
export const OutputFileSchema = z.object({
  name: z.string(),
  /** Absolute path; viewable through the aiw-file protocol. */
  path: z.string(),
  kind: AttachmentKindSchema,
  mimeType: z.string(),
  size: z.number(),
  modifiedAt: z.number(),
})
export type OutputFile = z.infer<typeof OutputFileSchema>

/** 3D formats the built-in viewer can display. */
export const MODEL_EXTENSIONS = ['glb', 'gltf', 'obj', 'stl', 'ply'] as const
export type ModelExtension = (typeof MODEL_EXTENSIONS)[number]

export const DEFAULT_IMAGE_MODEL = 'google/gemini-3.1-flash-lite-image'
