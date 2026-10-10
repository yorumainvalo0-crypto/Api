import { z } from 'zod'

export const ProviderIdSchema = z.enum(['anthropic', 'openrouter', 'ollama'])
export type ProviderId = z.infer<typeof ProviderIdSchema>

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  ollama: 'Ollama (local)',
}

export const SettingsSchema = z.object({
  activeProvider: ProviderIdSchema.default('anthropic'),
  /** Selected model id per provider. Empty string means "provider default". */
  models: z
    .object({
      anthropic: z.string().default(''),
      openrouter: z.string().default(''),
      ollama: z.string().default(''),
    })
    .default({ anthropic: '', openrouter: '', ollama: '' }),
  ollamaBaseUrl: z.url().default('http://localhost:11434'),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  /** Allow the agent to search the web and read pages (free, no API key). */
  webAccess: z.boolean().default(true),
  /** OpenRouter model used by the generate_image tool. */
  imageModel: z.string().default('google/gemini-3.1-flash-lite-image'),
  /** Stops a single request once it costs more than this (USD); 0 = no limit. */
  maxBudgetUsd: z.number().min(0).max(1000).default(0),
  /** Where generate_image runs: OpenRouter (cloud) or a local ComfyUI. */
  imageBackend: z.enum(['openrouter', 'comfyui']).default('openrouter'),
  comfyUrl: z.url().default('http://127.0.0.1:8188'),
  /** Checkpoint for the built-in text-to-image workflow (empty = first available). */
  comfyCheckpoint: z.string().default(''),
  /** Imported image workflow to use instead of the built-in one (empty = built-in). */
  comfyImageWorkflow: z.string().default(''),
  /** Long image side for the built-in workflow (512 for SD 1.5, 1024 for SDXL/Flux). */
  comfyResolution: z.number().int().min(256).max(2048).default(1024),
  /** Local handwriting/document OCR through an Ollama vision model. */
  ocrEnabled: z.boolean().default(false),
  ocrModel: z.string().default('qwen3-vl:8b-instruct'),
  /** Ollama address for OCR; empty = same as the chat Ollama address. */
  ocrBaseUrl: z.string().default(''),
  /** Seconds the OCR model stays on the GPU after use (0 = unload immediately). */
  ocrKeepAliveSec: z.number().int().min(0).max(3600).default(60),
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})

/**
 * Partial update sent from the renderer; validated in the main process.
 * Declared without defaults on purpose: `.partial()` would fill in defaults for missing keys
 * and silently reset settings the user did not touch.
 */
export const SettingsPatchSchema = z
  .object({
    activeProvider: ProviderIdSchema,
    models: z
      .object({ anthropic: z.string(), openrouter: z.string(), ollama: z.string() })
      .partial(),
    ollamaBaseUrl: z.url(),
    theme: z.enum(['system', 'light', 'dark']),
    webAccess: z.boolean(),
    imageModel: z.string(),
    maxBudgetUsd: z.number().min(0).max(1000),
    imageBackend: z.enum(['openrouter', 'comfyui']),
    comfyUrl: z.url(),
    comfyCheckpoint: z.string(),
    comfyImageWorkflow: z.string(),
    comfyResolution: z.number().int().min(256).max(2048),
    ocrEnabled: z.boolean(),
    ocrModel: z.string().min(1),
    ocrBaseUrl: z.union([z.literal(''), z.url()]),
    ocrKeepAliveSec: z.number().int().min(0).max(3600),
  })
  .partial()
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

/** Secret status exposed to the renderer – never the secret itself. */
export const SecretStatusSchema = z.object({
  anthropic: z.boolean(),
  openrouter: z.boolean(),
  ollama: z.boolean(),
  encryptionAvailable: z.boolean(),
})
export type SecretStatus = z.infer<typeof SecretStatusSchema>
