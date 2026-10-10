import { z } from 'zod'
import type { ConnectionTestResult, ModelInfo } from '@shared/schemas/models'
import { PROVIDER_LABELS, type ProviderId } from '@shared/schemas/settings'

export const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models'
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
export const CATALOG_TIMEOUT_MS = 15_000
const ANTHROPIC_VERSION = '2023-06-01'
const MAX_ANTHROPIC_PAGES = 20

export type ModelCatalogErrorKind =
  'missing-key' | 'auth' | 'network' | 'timeout' | 'aborted' | 'http' | 'invalid-response'

/** Error with a German, user-facing message. */
export class ModelCatalogError extends Error {
  override name = 'ModelCatalogError'

  constructor(
    message: string,
    readonly kind: ModelCatalogErrorKind,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface CatalogArgs {
  provider: ProviderId
  /** API key for the provider, or undefined when none is stored. */
  secret: string | undefined
  ollamaBaseUrl: string
  fetchImpl?: typeof fetch | undefined
  signal?: AbortSignal | undefined
}

// --- Response schemas (loose: extra fields are fine, optional ones may be missing) ---

const AnthropicModelsSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string(),
      display_name: z.string().nullish(),
      created_at: z.string().nullish(),
    }),
  ),
  has_more: z.boolean().nullish(),
  last_id: z.string().nullish(),
})

const OpenRouterModelsSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string().nullish(),
      created: z.number().nullish(),
      context_length: z.number().nullish(),
      architecture: z
        .looseObject({
          input_modalities: z.array(z.string()).nullish(),
          output_modalities: z.array(z.string()).nullish(),
        })
        .nullish(),
      pricing: z
        .looseObject({
          prompt: z.union([z.string(), z.number()]).nullish(),
          completion: z.union([z.string(), z.number()]).nullish(),
        })
        .nullish(),
    }),
  ),
})

const OllamaTagsSchema = z.looseObject({
  models: z.array(
    z.looseObject({
      name: z.string(),
      model: z.string().nullish(),
      modified_at: z.string().nullish(),
      details: z
        .looseObject({
          family: z.string().nullish(),
          parameter_size: z.string().nullish(),
        })
        .nullish(),
    }),
  ),
})

// --- Helpers ---

function compareLabels(a: ModelInfo, b: ModelInfo): number {
  return a.label.localeCompare(b.label, 'en', { sensitivity: 'base', numeric: true })
}

function sortModels(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort(compareLabels)
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/** Converts a USD-per-token value to USD per million tokens; undefined if unusable. */
function perMillionTokens(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const perToken = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(perToken) || perToken < 0) return undefined
  // Round away binary floating point noise (0.000003 * 1e6 = 2.9999999999999996).
  return Number((perToken * 1_000_000).toPrecision(12))
}

/** Short endpoint description for error messages, e.g. `Anthropic (api.anthropic.com)`. */
function describeEndpoint(provider: ProviderId, baseUrl: string): string {
  if (provider === 'ollama') return `Ollama (${baseUrl})`
  return `${PROVIDER_LABELS[provider]} (${new URL(baseUrl).host})`
}

function combinedSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(CATALOG_TIMEOUT_MS)
  return signal ? AbortSignal.any([timeout, signal]) : timeout
}

interface RequestArgs {
  provider: ProviderId
  url: string
  /** Endpoint description used in error messages. */
  target: string
  headers: Record<string, string>
  fetchImpl: typeof fetch
  signal: AbortSignal
}

/** Performs a GET request and returns the parsed JSON body, mapping failures to German errors. */
async function getJson(args: RequestArgs): Promise<unknown> {
  const { provider, url, target, headers, fetchImpl, signal } = args

  let res: Response
  try {
    res = await fetchImpl(url, { method: 'GET', headers, signal })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new ModelCatalogError(`Zeitüberschreitung bei der Verbindung zu ${target}.`, 'timeout')
    }
    if (signal.aborted) {
      throw new ModelCatalogError('Abgebrochen.', 'aborted')
    }
    throw new ModelCatalogError(`Keine Verbindung zu ${target}.`, 'network')
  }

  if (res.status === 401 || res.status === 403) {
    throw new ModelCatalogError(
      `API-Key ungültig (${PROVIDER_LABELS[provider]}, HTTP ${res.status}).`,
      'auth',
      res.status,
    )
  }
  if (res.status === 429) {
    throw new ModelCatalogError(
      `Zu viele Anfragen an ${target} (HTTP 429). Bitte später erneut versuchen.`,
      'http',
      429,
    )
  }
  if (!res.ok) {
    throw new ModelCatalogError(`${target} antwortete mit HTTP ${res.status}.`, 'http', res.status)
  }

  try {
    return await res.json()
  } catch {
    throw new ModelCatalogError(`Ungültige Antwort von ${target}.`, 'invalid-response')
  }
}

function parseResponse<T extends z.ZodType>(schema: T, json: unknown, target: string): z.output<T> {
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    throw new ModelCatalogError(`Unerwartetes Antwortformat von ${target}.`, 'invalid-response')
  }
  return parsed.data
}

// --- Providers ---

async function listAnthropic(
  secret: string | undefined,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<ModelInfo[]> {
  const key = nonEmpty(secret)
  if (!key) throw new ModelCatalogError('Kein Anthropic API-Key hinterlegt.', 'missing-key')

  const target = describeEndpoint('anthropic', ANTHROPIC_MODELS_URL)
  const models: ModelInfo[] = []
  let afterId: string | undefined
  for (let page = 0; page < MAX_ANTHROPIC_PAGES; page++) {
    const url = new URL(ANTHROPIC_MODELS_URL)
    url.searchParams.set('limit', '1000')
    if (afterId) url.searchParams.set('after_id', afterId)
    const href = url.toString()

    const json = await getJson({
      provider: 'anthropic',
      url: href,
      target,
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
      fetchImpl,
      signal,
    })
    const body = parseResponse(AnthropicModelsSchema, json, target)

    for (const item of body.data) {
      const createdAt = nonEmpty(item.created_at)
      models.push({
        id: item.id,
        label: nonEmpty(item.display_name) ?? item.id,
        provider: 'anthropic',
        inputModalities: ['text', 'image', 'file'],
        outputModalities: ['text'],
        ...(createdAt ? { createdAt } : {}),
      })
    }

    const lastId = nonEmpty(body.last_id)
    if (!body.has_more || !lastId || lastId === afterId) break
    afterId = lastId
  }
  return models
}

async function listOpenRouter(
  secret: string | undefined,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<ModelInfo[]> {
  const key = nonEmpty(secret)
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {}
  const target = describeEndpoint('openrouter', OPENROUTER_MODELS_URL)
  const json = await getJson({
    provider: 'openrouter',
    url: OPENROUTER_MODELS_URL,
    target,
    headers,
    fetchImpl,
    signal,
  })
  const body = parseResponse(OpenRouterModelsSchema, json, target)

  return body.data.map((item): ModelInfo => {
    const input = perMillionTokens(item.pricing?.prompt)
    const output = perMillionTokens(item.pricing?.completion)
    const inputModalities = item.architecture?.input_modalities
    const outputModalities = item.architecture?.output_modalities
    return {
      id: item.id,
      label: nonEmpty(item.name) ?? item.id,
      provider: 'openrouter',
      inputModalities: inputModalities?.length ? inputModalities : ['text'],
      outputModalities: outputModalities?.length ? outputModalities : ['text'],
      ...(item.context_length ? { contextLength: item.context_length } : {}),
      ...(input !== undefined && output !== undefined
        ? { pricing: { inputPerMTokUsd: input, outputPerMTokUsd: output } }
        : {}),
      ...(item.created ? { createdAt: new Date(item.created * 1000).toISOString() } : {}),
    }
  })
}

async function listOllama(
  baseUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<ModelInfo[]> {
  const root = baseUrl.trim().replace(/\/+$/, '')
  const target = `Ollama (${root})`
  const json = await getJson({
    provider: 'ollama',
    url: `${root}/api/tags`,
    target,
    headers: {},
    fetchImpl,
    signal,
  })
  const body = parseResponse(OllamaTagsSchema, json, target)

  return body.models.map((item): ModelInfo => {
    const size = nonEmpty(item.details?.parameter_size)
    const modifiedAt = nonEmpty(item.modified_at)
    return {
      id: nonEmpty(item.model) ?? item.name,
      label: size ? `${item.name} (${size})` : item.name,
      provider: 'ollama',
      inputModalities: ['text'],
      outputModalities: ['text'],
      ...(modifiedAt ? { createdAt: modifiedAt } : {}),
    }
  })
}

/**
 * Lists the models a provider offers, sorted by label.
 * @throws {ModelCatalogError} with a German message when the list cannot be fetched.
 */
export async function listModels(args: CatalogArgs): Promise<ModelInfo[]> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch
  const signal = combinedSignal(args.signal)
  switch (args.provider) {
    case 'anthropic':
      return sortModels(await listAnthropic(args.secret, fetchImpl, signal))
    case 'openrouter':
      return sortModels(await listOpenRouter(args.secret, fetchImpl, signal))
    case 'ollama':
      return sortModels(await listOllama(args.ollamaBaseUrl, fetchImpl, signal))
  }
}

/** Checks that the provider is reachable and the key works. Never throws. */
export async function testConnection(args: CatalogArgs): Promise<ConnectionTestResult> {
  const name = PROVIDER_LABELS[args.provider]
  try {
    const models = await listModels(args)
    const count = models.length
    if (args.provider === 'ollama' && count === 0) {
      return {
        ok: true,
        message: 'Ollama ist erreichbar, aber es sind noch keine Modelle installiert.',
        modelCount: 0,
      }
    }
    return {
      ok: true,
      message: `Verbindung zu ${name} erfolgreich (${count} ${count === 1 ? 'Modell' : 'Modelle'} verfügbar).`,
      modelCount: count,
    }
  } catch (err) {
    if (err instanceof ModelCatalogError) return { ok: false, message: err.message }
    return { ok: false, message: `Verbindungstest für ${name} fehlgeschlagen.` }
  }
}
