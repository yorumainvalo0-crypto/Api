import { ShieldQuestion } from 'lucide-react'
import type { AgentEvent, PermissionDecision } from '@shared/schemas/agent'
import { describeTool } from './ToolCard'
import { api } from '../../lib/api'

export type PermissionRequest = Extract<AgentEvent, { type: 'permission-request' }>

/** Inline approval card shown when the agent wants to use a tool. */
export function PermissionPrompt({ request }: { request: PermissionRequest }) {
  const { icon, title } = describeTool({
    id: request.requestId,
    name: request.toolName,
    input: request.input,
    result: null,
    isError: false,
  })

  const respond = (decision: PermissionDecision) =>
    void api.invoke('agent:permission-respond', { requestId: request.requestId, decision })

  return (
    <div className="space-y-2 rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/40">
      <div className="flex items-center gap-2 font-medium">
        <ShieldQuestion size={16} className="text-amber-600" />
        {request.title ?? `Darf der Agent „${request.toolName}“ verwenden?`}
      </div>
      <div className="flex items-center gap-2 font-mono text-xs text-zinc-600 dark:text-zinc-300">
        {icon}
        <span className="break-all">{title}</span>
      </div>
      {request.description && <p className="text-xs text-zinc-500">{request.description}</p>}
      {request.blockedPath && (
        <p className="text-xs text-zinc-500">Betroffener Pfad: {request.blockedPath}</p>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={() => respond('allow')}
          className="rounded-md bg-blue-600 px-3 py-1 text-white"
        >
          Erlauben
        </button>
        <button
          type="button"
          onClick={() => respond('allow-always')}
          className="rounded-md border border-zinc-300 px-3 py-1 dark:border-zinc-600"
        >
          Für diese Sitzung immer erlauben
        </button>
        <button
          type="button"
          onClick={() => respond('deny')}
          className="rounded-md border border-red-300 px-3 py-1 text-red-700 dark:border-red-800 dark:text-red-400"
        >
          Ablehnen
        </button>
      </div>
    </div>
  )
}
