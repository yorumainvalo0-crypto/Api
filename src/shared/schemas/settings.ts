import { z } from 'zod'
import { AgentPermissionModeSchema } from './permissions'

export const ProviderIdSchema = z.enum(['anthropic', 'openrouter', 'ollama'])
export type ProviderId = z.infer<typeof ProviderIdSchema>

/** Everything a key can be stored for: the chat providers plus TypeSafe (Jev). */
export const SecretIdSchema = z.enum([...ProviderIdSchema.options, 'typesafe'])
export type SecretId = z.infer<typeof SecretIdSchema>

/** Where the Jev decision model is called: TypeSafe directly or through OpenRouter. */
export const JevSourceSchema = z.enum(['typesafe', 'openrouter'])
export type JevSource = z.infer<typeof JevSourceSchema>

/** Reasoning effort for Claude models; "default" lets the model decide (nothing is sent). */
export const EffortSchema = z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max'])
export type Effort = z.infer<typeof EffortSchema>

export const EFFORT_LABELS: Record<Effort, string> = {
  default: 'Standard',
  low: 'Niedrig',
  medium: 'Mittel',
  high: 'Hoch',
  xhigh: 'Sehr hoch',
  max: 'Maximum',
}

/** A model setup the Cowork mode can route a request to or hand subtasks to. */
export const CoworkRoleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/, 'Nur Kleinbuchstaben, Ziffern und Bindestriche'),
  name: z.string().trim().min(1).max(40),
  /** What the role is good at – Jev and the coordinating model decide based on this. */
  description: z.string().trim().min(1).max(500),
  provider: ProviderIdSchema,
  /** Model id; empty = provider default. */
  model: z.string().max(200),
  effort: EffortSchema,
})
export type CoworkRole = z.infer<typeof CoworkRoleSchema>

export const DEFAULT_COWORK_ROLES: CoworkRole[] = [
  {
    id: 'schnell',
    name: 'Schnell',
    description:
      'Kurze Fragen, Fakten, Übersetzungen, Umformulieren, einfache Zusammenfassungen und kleine Recherchen.',
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    effort: 'low',
  },
  {
    id: 'standard',
    name: 'Standard',
    description:
      'Normale Aufgaben: Erklärungen, Texte schreiben, Dokumente erstellen, Code lesen und mittelgroße Änderungen.',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
  },
  {
    id: 'experte',
    name: 'Experte',
    description:
      'Schwierige Aufgaben: Architektur und Planung, komplexe Fehler, große Refactorings, lange Analysen und kritische Prüfungen.',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    effort: 'high',
  },
]

const CoworkRolesSchema = z
  .array(CoworkRoleSchema)
  .min(1)
  .max(12)
  .refine((roles) => new Set(roles.map((r) => r.id)).size === roles.length, 'Doppelte Rollen-ID')

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  ollama: 'Ollama (local)',
}

export const SETTINGS_VERSION = 2

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
  theme: z.enum(['system', 'light', 'dark']).default('dark'),
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
  /** How hard Claude thinks: higher is more thorough, slower and more expensive. */
  effort: EffortSchema.default('default'),
  /** Cowork: Jev routes each request to a role; the model can hand subtasks to other roles. */
  coworkEnabled: z.boolean().default(false),
  coworkRoles: CoworkRolesSchema.default(DEFAULT_COWORK_ROLES),
  /** Role used when Jev is not available. */
  coworkDefaultRole: z.string().default('standard'),
  /** Let the coordinating model start subagents (other roles) for subtasks. */
  coworkSubagents: z.boolean().default(true),
  /** Offer the Jev decision model (TypeSafe) as a tool to every chat model when a key exists. */
  jevEnabled: z.boolean().default(true),
  jevSource: JevSourceSchema.default('typesafe'),
  /** Jev model id; empty = latest for the chosen source. */
  jevModel: z.string().default(''),
  /** Permission mode for `claude` in the terminal and for new coding chats. */
  claudePermissionMode: AgentPermissionModeSchema.default('default'),
  /**
   * Claude Code may only read and change files inside the selected work folder (project folder of
   * a coding chat, folder of a terminal); shell commands run in the OS sandbox where available.
   */
  confineToWorkFolder: z.boolean().default(true),
  /** Version of the stored file, for one-time migrations of old defaults. */
  settingsVersion: z.number().int().default(SETTINGS_VERSION),
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
    effort: EffortSchema,
    coworkEnabled: z.boolean(),
    coworkRoles: CoworkRolesSchema,
    coworkDefaultRole: z.string(),
    coworkSubagents: z.boolean(),
    jevEnabled: z.boolean(),
    jevSource: JevSourceSchema,
    jevModel: z.string().max(200),
    claudePermissionMode: AgentPermissionModeSchema,
    confineToWorkFolder: z.boolean(),
  })
  .partial()
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

/** Secret status exposed to the renderer – never the secret itself. */
export const SecretStatusSchema = z.object({
  anthropic: z.boolean(),
  openrouter: z.boolean(),
  ollama: z.boolean(),
  typesafe: z.boolean(),
  encryptionAvailable: z.boolean(),
})
export type SecretStatus = z.infer<typeof SecretStatusSchema>
