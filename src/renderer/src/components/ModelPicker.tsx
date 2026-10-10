import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
import type { ModelInfo } from '@shared/schemas/models'
import type { ProviderId } from '@shared/schemas/settings'
import { api } from '../lib/api'
import { useDismiss } from '../lib/use-dismiss'

/** Searchable model list loaded live from the provider; free text is allowed as a fallback. */
export function ModelPicker(props: {
  provider: ProviderId
  value: string
  onChange: (modelId: string) => void
  compact?: boolean
  /** Restricts the list, e.g. to models that can output images. */
  filter?: (model: ModelInfo) => boolean
}) {
  const { provider, value, onChange } = props
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    api.invoke('models:list', { provider }).then(
      (list) => {
        if (cancelled) return
        setModels(list)
        setError(null)
        setLoading(false)
      },
      (e: unknown) => {
        if (cancelled) return
        setModels([])
        setError(cleanError(e))
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [provider, reloadToken])

  const reload = () => {
    setLoading(true)
    setReloadToken((t) => t + 1)
  }

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const base = props.filter ? models.filter(props.filter) : models
    const list = q
      ? base.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
      : base
    return list.slice(0, 200)
  }, [models, filter, props.filter])

  const current = models.find((m) => m.id === value)
  const rootRef = useRef<HTMLDivElement>(null)
  useDismiss(
    rootRef,
    open,
    useCallback(() => setOpen(false), []),
  )

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex max-w-full items-center gap-1 rounded-md border border-zinc-300 px-2 py-1 text-left text-sm dark:border-zinc-700 ${
          props.compact ? '' : 'w-full'
        }`}
      >
        <span className="truncate">{current?.label ?? (value || 'Standardmodell')}</span>
        <ChevronDown size={14} className="shrink-0 text-zinc-400" />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-[28rem] max-w-[90vw] rounded-lg border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex gap-2">
            <input
              autoFocus
              value={filter}
              placeholder="Suchen oder Modell-ID eingeben …"
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && filter.trim()) {
                  onChange(filtered[0]?.id ?? filter.trim())
                  setOpen(false)
                }
                if (e.key === 'Escape') setOpen(false)
              }}
              className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
            />
            <button
              type="button"
              title="Neu laden"
              onClick={reload}
              className="rounded-md border border-zinc-300 px-2 dark:border-zinc-700"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
          {error && <p className="mt-2 text-xs text-amber-600">{error}</p>}
          <ul className="mt-2 max-h-80 overflow-y-auto text-sm">
            {provider === 'anthropic' && (
              <ModelRow
                label="Standardmodell"
                detail="vom Runtime gewählt"
                active={!value}
                onClick={() => {
                  onChange('')
                  setOpen(false)
                }}
              />
            )}
            {filtered.map((m) => (
              <ModelRow
                key={m.id}
                label={m.label}
                detail={describe(m)}
                active={m.id === value}
                onClick={() => {
                  onChange(m.id)
                  setOpen(false)
                }}
              />
            ))}
            {!loading && filtered.length === 0 && filter.trim() && (
              <ModelRow
                label={`„${filter.trim()}“ verwenden`}
                detail="eigene Modell-ID"
                active={false}
                onClick={() => {
                  onChange(filter.trim())
                  setOpen(false)
                }}
              />
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

function ModelRow(props: { label: string; detail: string; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={props.onClick}
        className={`w-full rounded px-2 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
          props.active ? 'bg-blue-50 dark:bg-blue-950' : ''
        }`}
      >
        <div className="truncate">{props.label}</div>
        <div className="truncate text-xs text-zinc-500">{props.detail}</div>
      </button>
    </li>
  )
}

function describe(m: ModelInfo): string {
  const parts = [m.id]
  if (m.contextLength) parts.push(`${Math.round(m.contextLength / 1000)}k Kontext`)
  if (m.inputModalities.includes('image')) parts.push('Bilder')
  if (m.outputModalities.includes('image')) parts.push('erzeugt Bilder')
  if (m.pricing) {
    parts.push(`$${fmt(m.pricing.inputPerMTokUsd)}/$${fmt(m.pricing.outputPerMTokUsd)} pro 1M`)
  }
  return parts.join(' · ')
}

function fmt(n: number): string {
  return n >= 10 ? n.toFixed(0) : n.toFixed(2)
}

export function cleanError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  // Electron prefixes errors thrown in ipcMain handlers.
  return message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
}
