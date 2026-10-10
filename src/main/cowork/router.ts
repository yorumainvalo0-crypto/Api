import type { CoworkRole } from '@shared/schemas/settings'
import type { JevClient, JevResponse } from '../jev/client'

export interface RouteDecision {
  role: CoworkRole
  /** 'jev' when Jev picked the role, 'default' when it was unavailable or failed. */
  by: 'jev' | 'default'
  /** Jev's confidence for the chosen role (0–1); null without Jev. */
  confidence: number | null
  /** Probability that the task should be split into subtasks for several agents. */
  splitProbability: number | null
  /** German note for the UI when Jev could not be used. */
  note: string | null
  usage: JevResponse['usage'] | null
}

export interface RouteInput {
  prompt: string
  attachmentNames: string[]
  mode: 'chat' | 'code'
  roles: CoworkRole[]
  defaultRoleId: string
  jev: JevClient | undefined
  /** Whether subagents may be used (adds the split question). */
  subagents: boolean
}

const MAX_PROMPT_CHARS = 12_000

/** Picks the role (model + effort) that should handle a request; Jev decides when available. */
export async function routeRequest(input: RouteInput): Promise<RouteDecision> {
  const fallback = input.roles.find((r) => r.id === input.defaultRoleId) ?? input.roles[0]
  if (!fallback) throw new Error('Keine Cowork-Rollen eingerichtet.')
  const byDefault = (note: string | null): RouteDecision => ({
    role: fallback,
    by: 'default',
    confidence: null,
    splitProbability: null,
    note,
    usage: null,
  })
  if (!input.jev) return byDefault('Jev ist nicht aktiv – Standardrolle verwendet.')
  if (input.roles.length === 1) return byDefault(null)

  try {
    const response = await input.jev.evaluate(
      {
        request: input.prompt.slice(0, MAX_PROMPT_CHARS),
        attachments: input.attachmentNames,
        mode: input.mode === 'code' ? 'coding project with file and shell access' : 'chat',
      },
      {
        role: {
          type: 'choice',
          instructions:
            'Which role should handle this request? Prefer the cheapest role that can do it well; ' +
            'choose a stronger role only when the task really needs deeper reasoning.',
          criteria: Object.fromEntries(input.roles.map((r) => [r.id, r.description])),
        },
        ...(input.subagents
          ? {
              split: {
                type: 'noul' as const,
                instructions:
                  'Does this request contain several independent subtasks that different agents ' +
                  'could work on in parallel?',
              },
            }
          : {}),
      },
    )
    const answer = response.answers['role']
    const role =
      answer?.type === 'choice' ? input.roles.find((r) => r.id === answer.choice) : undefined
    if (!role)
      return { ...byDefault('Jev lieferte keine gültige Rolle.'), usage: response.usage ?? null }
    const split = response.answers['split']
    return {
      role,
      by: 'jev',
      confidence: answer?.type === 'choice' ? (answer.confidence ?? null) : null,
      splitProbability: split?.type === 'noul' ? split.noul : null,
      note: null,
      usage: response.usage ?? null,
    }
  } catch (error) {
    return byDefault(
      `Jev-Routing fehlgeschlagen (${error instanceof Error ? error.message : String(error)}) – Standardrolle verwendet.`,
    )
  }
}

/** Settings with the role's provider, model and effort applied. */
export function applyRole<
  S extends {
    activeProvider: CoworkRole['provider']
    models: Record<CoworkRole['provider'], string>
    effort: CoworkRole['effort']
  },
>(settings: S, role: CoworkRole): S {
  return {
    ...settings,
    activeProvider: role.provider,
    models: { ...settings.models, [role.provider]: role.model },
    effort: role.effort,
  }
}
