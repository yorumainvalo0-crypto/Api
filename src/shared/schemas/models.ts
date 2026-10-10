import { z } from 'zod'
import { ProviderIdSchema } from './settings'

export const ModelInfoSchema = z.object({
  /** Provider-specific model id, e.g. `claude-sonnet-4-5` or `qwen3:8b`. */
  id: z.string(),
  /** Human-readable name shown in the model picker. */
  label: z.string(),
  provider: ProviderIdSchema,
  contextLength: z.number().optional(),
  inputModalities: z.array(z.string()),
  outputModalities: z.array(z.string()),
  /** USD per million tokens. Omitted when unknown or variable. */
  pricing: z
    .object({
      inputPerMTokUsd: z.number(),
      outputPerMTokUsd: z.number(),
    })
    .optional(),
  /** ISO 8601 timestamp (release date for hosted models, modification date for Ollama). */
  createdAt: z.string().optional(),
})
export type ModelInfo = z.infer<typeof ModelInfoSchema>

export const ConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  /** German, user-facing message. */
  message: z.string(),
  modelCount: z.number().optional(),
})
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>
