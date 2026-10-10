import { useEffect, useRef, useState } from 'react'
import type { ContextUsage } from '@shared/schemas/usage'
import { api } from '../../lib/api'
import { formatTokens } from './format'

function level(percentage: number): { bar: string; text: string } {
  if (percentage >= 80) return { bar: 'bg-red-500', text: 'text-red-600 dark:text-red-400' }
  if (percentage >= 50) return { bar: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' }
  return { bar: 'bg-emerald-500', text: 'text-zinc-500' }
}

const KIND_LABELS: Record<ContextUsage['categories'][number]['kind'], string> = {
  used: '',
  free: 'frei',
  buffer: 'Reserve',
  deferred: 'bei Bedarf',
}

/** Shows how full the model's context window is after the chat's last answer. */
export function ContextMeter(props: { chatId: string }) {
  const { chatId } = props
  const [context, setContext] = useState<ContextUsage | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void api.invoke('usage:context', { chatId }).then((c) => {
      if (!cancelled) setContext(c)
    })
    const off = api.on('agent:event', (event) => {
      if (event.chatId === chatId && event.type === 'context') setContext(event.context)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [chatId])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  if (!context) return null
  const pct = Math.max(0, context.percentage)
  const colors = level(pct)
  const used = context.categories.filter((c) => c.kind === 'used')
  const other = context.categories.filter((c) => c.kind !== 'used')

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Kontext: wie voll das Gedächtnis des Modells in diesem Chat ist"
        className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
          <span
            className={`block h-full ${colors.bar}`}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </span>
        <span className={colors.text}>Kontext {pct} %</span>
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-80 rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <div className="mb-1 font-medium">Kontextfenster</div>
          <div className="mb-2 text-xs text-zinc-500">
            {formatTokens(context.usedTokens)} von {formatTokens(context.maxTokens)} Tokens belegt
            {context.model ? ` · ${context.model}` : ''}
          </div>
          <div className="mb-3 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
            <div className={`h-full ${colors.bar}`} style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          {used.length > 0 && (
            <table className="w-full text-xs">
              <tbody>
                {[...used, ...other].map((c) => (
                  <tr key={`${c.kind}-${c.name}`} className="text-zinc-600 dark:text-zinc-300">
                    <td className="py-0.5 pr-2">
                      {c.name}
                      {KIND_LABELS[c.kind] ? (
                        <span className="text-zinc-400"> ({KIND_LABELS[c.kind]})</span>
                      ) : null}
                    </td>
                    <td className="py-0.5 text-right tabular-nums">{formatTokens(c.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-xs text-zinc-500">
            {pct >= 80
              ? 'Fast voll: Ältere Teile werden bald automatisch zusammengefasst. Für ein neues Thema besser einen neuen Chat beginnen.'
              : 'Jede Antwort schickt den ganzen bisherigen Chat erneut an das Modell. Ein voller Kontext kostet daher mehr.'}
          </p>
        </div>
      )}
    </div>
  )
}
