import { Users } from 'lucide-react'
import { EFFORT_LABELS } from '@shared/schemas/settings'
import type { RouteInfo } from '@shared/schemas/chat'

/** Shows which Cowork role (model + effort) answered and why. */
export function RouteBadge(props: { route: RouteInfo }) {
  const { route } = props
  const pct = (n: number | null) => (n === null ? null : `${Math.round(n * 100)} %`)
  const confidence = pct(route.confidence)
  const split = pct(route.splitProbability)
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500"
      title={route.note ?? undefined}
    >
      <Users size={13} className="text-violet-500" />
      <span>
        Cowork: {route.by === 'jev' ? 'Jev wählte' : 'Standardrolle'}{' '}
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{route.roleName}</span> (
        {route.model || 'Standardmodell'}, Effort {EFFORT_LABELS[route.effort]})
      </span>
      {confidence && <span>· Sicherheit {confidence}</span>}
      {split && <span>· Aufteilen sinnvoll {split}</span>}
      {route.note && <span className="text-amber-600 dark:text-amber-400">· {route.note}</span>}
    </div>
  )
}
