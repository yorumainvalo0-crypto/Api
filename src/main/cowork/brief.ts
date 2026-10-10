import { EFFORT_LABELS, type CoworkRole } from '@shared/schemas/settings'
import { describeRole } from './mcp-server'
import type { RouteDecision } from './router'

/** System prompt section for the coordinating model in Cowork mode. */
export function coworkBrief(route: RouteDecision, roles: CoworkRole[], subagents: boolean): string {
  const lines = [
    '## Cowork-Modus',
    route.by === 'jev'
      ? `Jev (TypeSafe) hat diese Anfrage der Rolle „${route.role.name}“ zugewiesen` +
        (route.confidence !== null ? ` (Sicherheit ${Math.round(route.confidence * 100)} %)` : '') +
        '.'
      : `Diese Anfrage läuft mit der Standardrolle „${route.role.name}“.`,
    `Du bist diese Rolle (${route.role.model || 'Standardmodell'}, Effort ${EFFORT_LABELS[route.role.effort]}) und koordinierst die Arbeit.`,
  ]
  if (subagents) {
    lines.push(
      'Verfügbare Subagents (Werkzeug mcp__cowork__delegate):',
      ...roles.map((r) => `- ${describeRole(r)}`),
      'Gib Teilaufgaben ab, wenn sie unabhängig sind oder eine andere Rolle sie günstiger bzw. ' +
        'besser erledigt (z. B. Recherche an „Schnell“, schwierige Prüfung an „Experte“). Mehrere ' +
        'delegate-Aufrufe in einer Antwort laufen parallel. Subagents sehen den Chat nicht – gib ' +
        'ihnen alle nötigen Fakten. Prüfe ihre Ergebnisse und fasse sie für den Nutzer zusammen. ' +
        'Einfache Anfragen erledigst du selbst, ohne Subagents.',
    )
    if (route.splitProbability !== null) {
      lines.push(
        `Jev schätzt die Wahrscheinlichkeit, dass sich die Aufgabe sinnvoll aufteilen lässt, auf ${Math.round(route.splitProbability * 100)} %.`,
      )
    }
  }
  return lines.join('\n')
}

export const SUBAGENT_NOTE =
  'Du bist ein Subagent im Cowork-Modus der AI Workbench. Du bekommst eine abgeschlossene ' +
  'Teilaufgabe vom koordinierenden Modell, nicht direkt vom Nutzer. Erledige sie vollständig und ' +
  'antworte mit dem Ergebnis (knapp, ohne Rückfragen); der Koordinator fasst es für den Nutzer zusammen.'
