import { z } from 'zod'
import type { JevSource } from '@shared/schemas/settings'

export class JevError extends Error {
  override name = 'JevError'
}

export const JEV_ENDPOINTS: Record<JevSource, string> = {
  typesafe: 'https://api.typesafe.ai/v1/systemone',
  openrouter: 'https://openrouter.ai/api/v1/systemone',
}

export const JEV_DEFAULT_MODELS: Record<JevSource, string> = {
  typesafe: 'jev-latest',
  openrouter: '~typesafe/jev-latest',
}

/** Text, object or array – the API accepts all three for state, instructions and criteria. */
const Content = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])

export const JevQuestionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('noul'),
    instructions: Content.describe('Yes/no question; the answer is P(yes) from 0 to 1'),
    criteria: z
      .object({ true: Content.optional(), false: Content.optional() })
      .optional()
      .describe('Optional: what yes (true) and no (false) mean'),
  }),
  z.object({
    type: z.literal('choice'),
    instructions: Content.describe('What to decide, e.g. "Which team should handle this?"'),
    criteria: z
      .record(z.string(), z.union([Content, z.null()]))
      .refine((c) => {
        const n = Object.keys(c).length
        return n >= 1 && n <= 255
      }, '1–255 options')
      .describe('Options: name → description (string, list, object or null)'),
  }),
  z.object({
    type: z.literal('score'),
    instructions: Content.describe('What to rate, e.g. "How severe is the issue?"'),
    criteria: z
      .array(Content)
      .min(2)
      .max(10)
      .describe('Ordered levels from lowest to highest (2–10)'),
  }),
])
export type JevQuestion = z.infer<typeof JevQuestionSchema>

const Probabilities = z.record(z.string(), z.number())
const AnswerSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('noul'), noul: z.number() }),
  z.looseObject({
    type: z.literal('choice'),
    choice: z.string(),
    confidence: z.number().optional(),
    probabilities: Probabilities.optional(),
  }),
  z.looseObject({
    type: z.literal('score'),
    score: z.number(),
    confidence: z.number().optional(),
    legend: z.record(z.string(), z.unknown()).optional(),
    probabilities: Probabilities.optional(),
  }),
])
export type JevAnswer = z.infer<typeof AnswerSchema>

const ResponseSchema = z.looseObject({
  model: z.string().optional(),
  answers: z.record(z.string(), AnswerSchema),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .optional(),
})
export type JevResponse = z.infer<typeof ResponseSchema>

export interface JevClientOptions {
  source: JevSource
  apiKey: string
  model?: string | undefined
  /** Overrides the endpoint (tests). */
  endpoint?: string | undefined
  fetchImpl?: typeof fetch | undefined
  /** Delay before retrying 429/529 (ms); doubled per attempt. */
  retryDelayMs?: number
}

const SOURCE_LABELS: Record<JevSource, string> = {
  typesafe: 'TypeSafe',
  openrouter: 'OpenRouter',
}

/** Client for TypeSafe's Jev "System One" endpoint: typed, calibrated decisions. */
export class JevClient {
  private readonly fetch: typeof fetch

  constructor(private readonly options: JevClientOptions) {
    this.fetch = options.fetchImpl ?? fetch
  }

  get model(): string {
    return this.options.model || JEV_DEFAULT_MODELS[this.options.source]
  }

  async evaluate(
    state: unknown,
    questions: Record<string, JevQuestion>,
    signal?: AbortSignal,
  ): Promise<JevResponse> {
    const endpoint = this.options.endpoint ?? JEV_ENDPOINTS[this.options.source]
    const body = JSON.stringify({ model: this.model, state, questions })
    const label = SOURCE_LABELS[this.options.source]
    let delay = this.options.retryDelayMs ?? 1000

    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await this.fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            'content-type': 'application/json',
          },
          body,
          signal: signal ?? AbortSignal.timeout(60_000),
        })
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          throw new JevError(`Zeitüberschreitung bei ${label} (Jev).`)
        }
        throw new JevError(`${label} (Jev) ist nicht erreichbar.`)
      }
      // Rate limit / overloaded: retry twice with backoff, like the official SDKs.
      if ((response.status === 429 || response.status === 529) && attempt < 2) {
        await new Promise((r) => setTimeout(r, delay))
        delay *= 2
        continue
      }
      const data: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new JevError(describeError(label, response.status, data))
      const parsed = ResponseSchema.safeParse(data)
      if (!parsed.success) throw new JevError(`Unerwartete Antwort von ${label} (Jev).`)
      return parsed.data
    }
  }
}

function describeError(label: string, status: number, body: unknown): string {
  const detail = z
    .looseObject({
      error: z.union([z.string(), z.looseObject({ message: z.string() })]).optional(),
      message: z.string().optional(),
      detail: z.unknown().optional(),
    })
    .safeParse(body)
  const d = detail.success ? detail.data : undefined
  const text =
    typeof d?.error === 'string'
      ? d.error
      : (d?.error?.message ??
        d?.message ??
        (d?.detail !== undefined ? JSON.stringify(d.detail).slice(0, 300) : ''))
  const reason =
    status === 401
      ? `API-Key ungültig oder fehlt`
      : status === 402
        ? 'kein Guthaben'
        : status === 422
          ? 'ungültige Frage'
          : status === 429
            ? 'zu viele Anfragen'
            : status === 529
              ? 'überlastet'
              : `HTTP ${status}`
  return `Jev über ${label}: ${reason}${text ? ` – ${text}` : ''}.`
}

/** Compact, model-friendly text for the tool result. */
export function formatJevResponse(response: JevResponse): string {
  const round = (n: number) => Math.round(n * 1000) / 1000
  const answers = Object.fromEntries(
    Object.entries(response.answers).map(([key, a]) => {
      switch (a.type) {
        case 'noul':
          return [key, { type: 'noul', p_yes: round(a.noul) }]
        case 'choice':
          return [
            key,
            {
              type: 'choice',
              choice: a.choice,
              confidence: a.confidence === undefined ? undefined : round(a.confidence),
              probabilities: a.probabilities
                ? Object.fromEntries(Object.entries(a.probabilities).map(([k, v]) => [k, round(v)]))
                : undefined,
            },
          ]
        case 'score':
          return [
            key,
            {
              type: 'score',
              score: round(a.score),
              confidence: a.confidence === undefined ? undefined : round(a.confidence),
              legend: a.legend,
            },
          ]
      }
    }),
  )
  return JSON.stringify({ model: response.model, answers }, null, 1)
}
