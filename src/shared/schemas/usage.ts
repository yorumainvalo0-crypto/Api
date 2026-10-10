import { z } from 'zod'
import { ProviderIdSchema } from './settings'

export const UsageRangeSchema = z.enum(['today', '7d', '30d', 'month', 'all'])
export type UsageRange = z.infer<typeof UsageRangeSchema>

const ProviderAmountsSchema = z.object({
  anthropic: z.number(),
  openrouter: z.number(),
  ollama: z.number(),
})
export type ProviderAmounts = z.infer<typeof ProviderAmountsSchema>

export const UsageTotalsSchema = z.object({
  /** Number of answers (one user message → one request, even with several model calls). */
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number(),
})
export type UsageTotals = z.infer<typeof UsageTotalsSchema>

export const UsageSummarySchema = z.object({
  range: UsageRangeSchema,
  /** Start of the range (epoch ms), null for "all". */
  since: z.number().nullable(),
  total: UsageTotalsSchema,
  byProvider: z.array(UsageTotalsSchema.extend({ provider: ProviderIdSchema })),
  byModel: z.array(UsageTotalsSchema.extend({ provider: ProviderIdSchema, model: z.string() })),
  /** Hours of today for "today", calendar days otherwise. */
  granularity: z.enum(['hour', 'day']),
  /** Continuous time series (empty buckets included), oldest first. */
  series: z.array(
    z.object({
      /** Bucket start (epoch ms, local time). */
      start: z.number(),
      requests: z.number(),
      costByProvider: ProviderAmountsSchema,
      tokensByProvider: ProviderAmountsSchema,
    }),
  ),
})
export type UsageSummary = z.infer<typeof UsageSummarySchema>

export const ContextCategorySchema = z.object({
  name: z.string(),
  tokens: z.number(),
  kind: z.enum(['used', 'free', 'buffer', 'deferred']),
})

/** How full the model's context window is after the last answer of a chat. */
export const ContextUsageSchema = z.object({
  model: z.string(),
  usedTokens: z.number(),
  maxTokens: z.number(),
  percentage: z.number(),
  categories: z.array(ContextCategorySchema),
  updatedAt: z.number(),
})
export type ContextUsage = z.infer<typeof ContextUsageSchema>
