import { z } from 'zod'
import type { ContextUsage } from '@shared/schemas/usage'

const CategorySchema = z.looseObject({
  name: z.string(),
  tokens: z.number(),
  kind: z.enum(['used', 'free', 'buffer', 'deferred']).catch('used'),
})

// The runtime answers in camelCase; the SDK types document snake_case. Accept both.
const ResponseSchema = z.looseObject({
  model: z.string().optional(),
  totalTokens: z.number().optional(),
  total_tokens: z.number().optional(),
  maxTokens: z.number().optional(),
  rawMaxTokens: z.number().optional(),
  raw_max_tokens: z.number().optional(),
  percentage: z.number().optional(),
  categories: z.array(CategorySchema).catch([]).default([]),
})

/** Converts the runtime's getContextUsage() answer; undefined when it is not usable. */
export function parseContextResponse(raw: unknown, now = Date.now()): ContextUsage | undefined {
  const parsed = ResponseSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const r = parsed.data
  const used = r.totalTokens ?? r.total_tokens
  const max = r.maxTokens ?? r.rawMaxTokens ?? r.raw_max_tokens
  if (used === undefined || !max) return undefined
  return {
    model: r.model ?? '',
    usedTokens: used,
    maxTokens: max,
    percentage: r.percentage ?? Math.round((used / max) * 100),
    categories: r.categories
      .filter((c) => c.tokens > 0)
      .map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
    updatedAt: now,
  }
}

interface ResultUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/**
 * Estimate from the last API call when the runtime cannot report a breakdown: everything the
 * model read plus what it wrote is in the context of the next turn.
 */
export function contextFromResult(
  usage: ResultUsage | undefined,
  modelUsage: Record<string, { contextWindow?: number }> | undefined,
  model: string,
  now = Date.now(),
): ContextUsage | undefined {
  if (!usage) return undefined
  const used =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.output_tokens ?? 0)
  const max =
    modelUsage?.[model]?.contextWindow ??
    Math.max(0, ...Object.values(modelUsage ?? {}).map((m) => m.contextWindow ?? 0))
  if (!used || !max) return undefined
  return {
    model,
    usedTokens: used,
    maxTokens: max,
    percentage: Math.round((used / max) * 100),
    categories: [],
    updatedAt: now,
  }
}
