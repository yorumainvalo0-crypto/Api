import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { PROVIDER_LABELS, ProviderIdSchema } from '@shared/schemas/settings'
import type { UsageRange, UsageSummary, UsageTotals } from '@shared/schemas/usage'
import { api } from '../../lib/api'
import { PROVIDER_COLORS, formatTokens, formatTokensShort, formatUsd } from './format'

const RANGES: { id: UsageRange; label: string }[] = [
  { id: 'today', label: 'Heute' },
  { id: '7d', label: '7 Tage' },
  { id: '30d', label: '30 Tage' },
  { id: 'month', label: 'Dieser Monat' },
  { id: 'all', label: 'Gesamt' },
]

type Metric = 'cost' | 'tokens' | 'requests'

const METRICS: { id: Metric; label: string }[] = [
  { id: 'cost', label: 'Kosten' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'requests', label: 'Anfragen' },
]

const PROVIDERS = ProviderIdSchema.options

/** Statistics of tokens, costs and requests per provider, model and time. */
export function UsageView() {
  const [range, setRange] = useState<UsageRange>('7d')
  const [metric, setMetric] = useState<Metric>('cost')
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [version, setVersion] = useState(0)
  const reload = () => setVersion((v) => v + 1)

  useEffect(() => {
    let cancelled = false
    api.invoke('usage:summary', { range }).then(
      (result) => {
        if (cancelled) return
        setSummary(result)
        setError(null)
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      },
    )
    return () => {
      cancelled = true
    }
  }, [range, version])

  // Refresh when an answer finishes while the view is open.
  useEffect(() => {
    return api.on('agent:event', (event) => {
      if (event.type === 'done') setVersion((v) => v + 1)
    })
  }, [])

  return (
    <div className="h-full flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 p-8">
        <header className="flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <h1 className="text-2xl font-semibold">Verbrauch</h1>
            <p className="text-sm text-zinc-500">
              Tokens, Kosten und Nutzung je Anbieter und Modell
            </p>
          </div>
          <Segmented options={RANGES} value={range} onChange={setRange} />
          <button
            type="button"
            title="Aktualisieren"
            aria-label="Aktualisieren"
            onClick={reload}
            className="rounded-md border border-zinc-300 p-1.5 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <RefreshCw size={16} />
          </button>
        </header>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {summary && (
          <>
            <Cards total={summary.total} />
            <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <h2 className="mr-auto font-medium">
                  Verlauf {summary.granularity === 'hour' ? 'pro Stunde' : 'pro Tag'}
                </h2>
                <Legend />
                <Segmented options={METRICS} value={metric} onChange={setMetric} />
              </div>
              <Chart summary={summary} metric={metric} />
            </section>
            <Breakdown summary={summary} />
          </>
        )}
        <p className="text-xs text-zinc-500">
          Die Kosten sind Schätzungen nach Listenpreisen, die die Claude-Laufzeit berechnet.
          Maßgeblich ist die Abrechnung des Anbieters. Ollama läuft lokal und kostet nichts. Bei
          OpenRouter können die Preise abweichen. Für Antworten aus der Zeit vor dem
          Verbrauchs-Update sind nur die Kosten bekannt, keine Tokens.
        </p>
      </div>
    </div>
  )
}

function Segmented<T extends string>(props: {
  options: { id: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex rounded-md border border-zinc-300 p-0.5 text-sm dark:border-zinc-700">
      {props.options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => props.onChange(o.id)}
          className={`rounded px-2.5 py-1 ${
            props.value === o.id
              ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Cards(props: { total: UsageTotals }) {
  const t = props.total
  const cards = [
    { label: 'Kosten', value: formatUsd(t.costUsd) },
    { label: 'Anfragen', value: t.requests.toLocaleString('de-DE') },
    { label: 'Eingabe-Tokens', value: formatTokens(t.inputTokens) },
    { label: 'Ausgabe-Tokens', value: formatTokens(t.outputTokens) },
    {
      label: 'Cache gelesen / geschrieben',
      value: `${formatTokens(t.cacheReadTokens)} / ${formatTokens(t.cacheWriteTokens)}`,
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <div className="text-xs text-zinc-500">{c.label}</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">{c.value}</div>
        </div>
      ))}
    </div>
  )
}

function Legend() {
  return (
    <div className="flex gap-3 text-xs text-zinc-500">
      {PROVIDERS.map((p) => (
        <span key={p} className="flex items-center gap-1">
          <span className={`h-2.5 w-2.5 rounded-sm ${PROVIDER_COLORS[p]}`} />
          {PROVIDER_LABELS[p]}
        </span>
      ))}
    </div>
  )
}

function bucketLabel(start: number, granularity: 'hour' | 'day'): string {
  const d = new Date(start)
  return granularity === 'hour'
    ? `${String(d.getHours()).padStart(2, '0')}:00`
    : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
}

function Chart(props: { summary: UsageSummary; metric: Metric }) {
  const { summary, metric } = props
  const points = summary.series
  const valueOf = (p: (typeof points)[number]) =>
    metric === 'cost'
      ? PROVIDERS.reduce((s, id) => s + p.costByProvider[id], 0)
      : metric === 'tokens'
        ? PROVIDERS.reduce((s, id) => s + p.tokensByProvider[id], 0)
        : p.requests
  const max = Math.max(0, ...points.map(valueOf))
  const format = (v: number) =>
    metric === 'cost' ? formatUsd(v) : metric === 'tokens' ? formatTokensShort(v) : String(v)
  // About eight labels on the x axis.
  const labelEvery = Math.max(1, Math.ceil(points.length / 8))

  if (max === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-zinc-500">
        {metric === 'cost' && points.some((p) => p.requests > 0)
          ? 'Keine Kosten in diesem Zeitraum (lokale Modelle sind kostenlos) – siehe „Tokens“.'
          : 'Keine Nutzung in diesem Zeitraum.'}
      </div>
    )
  }
  return (
    <div>
      <div className="mb-1 text-right text-xs text-zinc-400 tabular-nums">max. {format(max)}</div>
      <div className="flex h-40 items-end gap-px border-b border-zinc-200 dark:border-zinc-700">
        {points.map((p) => {
          const total = valueOf(p)
          const title = `${bucketLabel(p.start, summary.granularity)}: ${formatUsd(
            PROVIDERS.reduce((s, id) => s + p.costByProvider[id], 0),
          )} · ${formatTokens(
            PROVIDERS.reduce((s, id) => s + p.tokensByProvider[id], 0),
          )} Tokens · ${p.requests} Anfragen`
          return (
            <div
              key={p.start}
              title={title}
              className="flex h-full min-w-0 flex-1 flex-col-reverse hover:opacity-80"
            >
              {metric === 'requests' ? (
                <div className="bg-blue-500" style={{ height: `${(total / max) * 100}%` }} />
              ) : (
                PROVIDERS.map((id) => {
                  const v = metric === 'cost' ? p.costByProvider[id] : p.tokensByProvider[id]
                  return v > 0 ? (
                    <div
                      key={id}
                      className={PROVIDER_COLORS[id]}
                      style={{ height: `${(v / max) * 100}%` }}
                    />
                  ) : null
                })
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-1 flex gap-px text-[10px] text-zinc-400">
        {points.map((p, i) => (
          <div key={p.start} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">
            {i % labelEvery === 0 ? bucketLabel(p.start, summary.granularity) : ''}
          </div>
        ))}
      </div>
    </div>
  )
}

function TotalsCells(props: { t: UsageTotals }) {
  const { t } = props
  return (
    <>
      <td className="px-2 py-1.5 text-right tabular-nums">{t.requests}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{formatTokens(t.inputTokens)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{formatTokens(t.outputTokens)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">
        {formatTokens(t.cacheReadTokens + t.cacheWriteTokens)}
      </td>
      <td className="px-2 py-1.5 text-right font-medium tabular-nums">{formatUsd(t.costUsd)}</td>
    </>
  )
}

function Breakdown(props: { summary: UsageSummary }) {
  const { summary } = props
  if (summary.byModel.length === 0) return null
  const head = (
    <tr className="text-left text-xs text-zinc-500">
      <th className="px-2 py-1.5 font-normal">Anbieter / Modell</th>
      <th className="px-2 py-1.5 text-right font-normal">Anfragen</th>
      <th className="px-2 py-1.5 text-right font-normal">Eingabe</th>
      <th className="px-2 py-1.5 text-right font-normal">Ausgabe</th>
      <th className="px-2 py-1.5 text-right font-normal">Cache</th>
      <th className="px-2 py-1.5 text-right font-normal">Kosten</th>
    </tr>
  )
  return (
    <section className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-sm">
        <thead className="border-b border-zinc-200 dark:border-zinc-800">{head}</thead>
        <tbody>
          {summary.byProvider.map((p) => (
            <ProviderRows key={p.provider} provider={p} summary={summary} />
          ))}
        </tbody>
      </table>
    </section>
  )
}

function ProviderRows(props: {
  provider: UsageSummary['byProvider'][number]
  summary: UsageSummary
}) {
  const { provider, summary } = props
  const models = summary.byModel.filter((m) => m.provider === provider.provider)
  return (
    <>
      <tr className="border-t border-zinc-200 bg-zinc-50 font-medium dark:border-zinc-800 dark:bg-zinc-900">
        <td className="px-2 py-1.5">
          <span className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-sm ${PROVIDER_COLORS[provider.provider]}`} />
            {PROVIDER_LABELS[provider.provider]}
          </span>
        </td>
        <TotalsCells t={provider} />
      </tr>
      {models.map((m) => (
        <tr key={m.model} className="text-zinc-600 dark:text-zinc-300">
          <td className="truncate px-2 py-1.5 pl-7 font-mono text-xs">{m.model}</td>
          <TotalsCells t={m} />
        </tr>
      ))}
    </>
  )
}
