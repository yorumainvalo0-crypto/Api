import { z } from 'zod'

/**
 * How Claude Code asks before using tools (maps to the runtime's permission modes). Used by the
 * coding chat and by `claude` in the app terminal. Kept apart from ./chat.ts so the settings
 * schema can use it without an import cycle.
 */
export const AgentPermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'auto',
  'plan',
  'bypassPermissions',
])
export type AgentPermissionMode = z.infer<typeof AgentPermissionModeSchema>

export const PERMISSION_MODE_LABELS: Record<AgentPermissionMode, string> = {
  default: 'Immer fragen',
  acceptEdits: 'Dateiänderungen erlauben',
  auto: 'Automatisch (KI prüft)',
  plan: 'Nur planen',
  bypassPermissions: 'Alles erlauben',
}

export const PERMISSION_MODE_HINTS: Record<AgentPermissionMode, string> = {
  default: 'Fragt vor jeder Dateiänderung und jedem Befehl.',
  acceptEdits: 'Dateiänderungen im Arbeitsordner ohne Rückfrage, Befehle werden nachgefragt.',
  auto:
    'Ein Prüfmodell (Claude Sonnet) entscheidet je Aktion, ob sie sicher ist, und fragt nur im ' +
    'Zweifel nach. Braucht Anthropic oder OpenRouter; mit Ollama gilt stattdessen ' +
    '„Dateiänderungen erlauben“.',
  plan: 'Liest und plant nur, ändert nichts.',
  bypassPermissions: 'Führt alles ohne Rückfrage aus.',
}

/** Whether the OS sandbox of Claude Code confines shell commands on this computer. */
export const SandboxStatusSchema = z.object({
  /** True when the app enables the sandbox for shell commands (Bash) of Claude Code. */
  active: z.boolean(),
  platform: z.string(),
  /** One German sentence for the settings and the terminal. */
  summary: z.string(),
})
export type SandboxStatus = z.infer<typeof SandboxStatusSchema>
