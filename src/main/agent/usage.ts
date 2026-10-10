/** Token and cost totals of one model, as reported in the SDK result's modelUsage. */
export interface ModelTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

/** Cumulative totals of an SDK session after its last answer. */
export interface UsageSnapshot {
  sessionId: string
  models: Record<string, ModelTotals>
}

interface SdkModelUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  costUSD?: number
}

const FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'costUsd',
] as const

export function fromSdkModelUsage(
  modelUsage: Record<string, SdkModelUsage> | undefined,
): Record<string, ModelTotals> {
  const result: Record<string, ModelTotals> = {}
  for (const [model, u] of Object.entries(modelUsage ?? {})) {
    result[model] = {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheReadTokens: u.cacheReadInputTokens ?? 0,
      cacheWriteTokens: u.cacheCreationInputTokens ?? 0,
      costUsd: u.costUSD ?? 0,
    }
  }
  return result
}

function isEmpty(t: ModelTotals): boolean {
  return FIELDS.every((f) => t[f] === 0)
}

/**
 * The SDK reports usage cumulatively for a session, also across `resume`. This returns what the
 * latest answer alone used: the difference to the previous snapshot of the same session. A
 * different session or shrinking totals (e.g. after /clear) count as a fresh start.
 */
export function usageDelta(
  previous: UsageSnapshot | undefined,
  sessionId: string,
  current: Record<string, ModelTotals>,
): Record<string, ModelTotals> {
  const base = previous?.sessionId === sessionId ? previous.models : {}
  const delta: Record<string, ModelTotals> = {}
  for (const [model, now] of Object.entries(current)) {
    const before = base[model]
    const reset = !before || FIELDS.some((f) => now[f] < before[f])
    const diff: ModelTotals = reset
      ? { ...now }
      : {
          inputTokens: now.inputTokens - before.inputTokens,
          outputTokens: now.outputTokens - before.outputTokens,
          cacheReadTokens: now.cacheReadTokens - before.cacheReadTokens,
          cacheWriteTokens: now.cacheWriteTokens - before.cacheWriteTokens,
          costUsd: now.costUsd - before.costUsd,
        }
    if (!isEmpty(diff)) delta[model] = diff
  }
  return delta
}

export function sumTotals(models: Record<string, ModelTotals>): ModelTotals {
  const sum: ModelTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  }
  for (const t of Object.values(models)) for (const f of FIELDS) sum[f] += t[f]
  return sum
}
