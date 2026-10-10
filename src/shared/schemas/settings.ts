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
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})

/** Partial update sent from the renderer; validated in the main process. */
export const SettingsPatchSchema = SettingsSchema.partial()
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

/** Secret status exposed to the renderer – never the secret itself. */
export const SecretStatusSchema = z.object({
  anthropic: z.boolean(),
  openrouter: z.boolean(),
  ollama: z.boolean(),
  encryptionAvailable: z.boolean(),
})
export type SecretStatus = z.infer<typeof SecretStatusSchema>
