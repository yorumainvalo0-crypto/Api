import type { ProviderId } from '@shared/schemas/settings'

/** 950 → "950", 12_345 → "12,3 Tsd.", 4_200_000 → "4,2 Mio." */
export function formatTokens(n: number): string {
  if (n < 1000) return n.toLocaleString('de-DE')
  if (n < 1_000_000)
    return `${(n / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Tsd.`
  return `${(n / 1_000_000).toLocaleString('de-DE', { maximumFractionDigits: 2 })} Mio.`
}

/** Short form for chart labels: 12.3k, 4.2M. */
export function formatTokensShort(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 10) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

export const PROVIDER_COLORS: Record<ProviderId, string> = {
  anthropic: 'bg-orange-500',
  openrouter: 'bg-violet-500',
  ollama: 'bg-emerald-500',
}
