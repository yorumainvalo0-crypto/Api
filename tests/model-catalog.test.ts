import { describe, expect, it } from 'vitest'
import { ModelCatalogError, listModels, testConnection } from '../src/main/providers/model-catalog'

interface Call {
  url: string
  headers: Record<string, string>
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fakeFetch(handler: (url: string, call: number) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } })
    return handler(url, calls.length - 1)
  }) as typeof fetch
  return { fetchImpl, calls }
}

const base = { ollamaBaseUrl: 'http://localhost:11434' }

describe('listModels – anthropic', () => {
  it('sends auth headers, follows pagination and sorts by label', async () => {
    const { fetchImpl, calls } = fakeFetch((_url, call) =>
      call === 0
        ? json({
            data: [
              { id: 'claude-b', display_name: 'Claude B', created_at: '2025-02-01T00:00:00Z' },
            ],
            has_more: true,
            last_id: 'claude-b',
          })
        : json({
            data: [{ id: 'claude-a', display_name: 'Claude A', type: 'model' }],
            has_more: false,
            last_id: 'claude-a',
          }),
    )
    const models = await listModels({ ...base, provider: 'anthropic', secret: 'sk-ant', fetchImpl })

    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000')
    expect(calls[1]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000&after_id=claude-b')
    expect(calls[0]?.headers['x-api-key']).toBe('sk-ant')
    expect(calls[0]?.headers['anthropic-version']).toBe('2023-06-01')
    expect(models.map((m) => m.label)).toEqual(['Claude A', 'Claude B'])
    expect(models[1]).toMatchObject({
      id: 'claude-b',
      provider: 'anthropic',
      inputModalities: ['text', 'image', 'file'],
      outputModalities: ['text'],
      createdAt: '2025-02-01T00:00:00Z',
    })
  })

  it('throws a German ModelCatalogError without a key', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ data: [] }))
    const promise = listModels({ ...base, provider: 'anthropic', secret: undefined, fetchImpl })
    await expect(promise).rejects.toBeInstanceOf(ModelCatalogError)
    await expect(promise).rejects.toThrow('Kein Anthropic API-Key hinterlegt.')
    expect(calls).toHaveLength(0)
  })
})

describe('listModels – openrouter', () => {
  const body = {
    data: [
      {
        id: 'vendor/model-b',
        name: 'Vendor: B',
        created: 1_700_000_000,
        context_length: 128000,
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        pricing: { prompt: '0.000003', completion: '0.000015' },
      },
      {
        id: 'vendor/router',
        name: 'Vendor: Auto Router',
        pricing: { prompt: '-1', completion: '-1' },
      },
    ],
  }

  it('converts pricing to USD per million tokens and keeps modalities', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(body))
    const models = await listModels({
      ...base,
      provider: 'openrouter',
      secret: 'or-key',
      fetchImpl,
    })

    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/models')
    expect(calls[0]?.headers['Authorization']).toBe('Bearer or-key')
    const model = models.find((m) => m.id === 'vendor/model-b')
    expect(model).toMatchObject({
      label: 'Vendor: B',
      contextLength: 128000,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      pricing: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
      createdAt: new Date(1_700_000_000 * 1000).toISOString(),
    })
  })

  it('omits pricing for variable (-1) prices and defaults modalities', async () => {
    const { fetchImpl } = fakeFetch(() => json(body))
    const models = await listModels({
      ...base,
      provider: 'openrouter',
      secret: undefined,
      fetchImpl,
    })
    const router = models.find((m) => m.id === 'vendor/router')
    expect(router).toBeDefined()
    expect(router?.pricing).toBeUndefined()
    expect(router?.inputModalities).toEqual(['text'])
    expect(router?.outputModalities).toEqual(['text'])
  })

  it('works without a key and sends no Authorization header', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(body))
    await listModels({ ...base, provider: 'openrouter', secret: '  ', fetchImpl })
    expect(calls[0]?.headers['Authorization']).toBeUndefined()
  })
})

describe('listModels – ollama', () => {
  it('strips trailing slashes and builds labels from parameter_size', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({
        models: [
          {
            name: 'qwen3:8b',
            model: 'qwen3:8b',
            modified_at: '2025-06-01T10:00:00Z',
            details: { family: 'qwen3', parameter_size: '8.2B' },
          },
          { name: 'custom:latest', model: 'custom:latest' },
        ],
      }),
    )
    const models = await listModels({
      provider: 'ollama',
      secret: undefined,
      ollamaBaseUrl: 'http://localhost:11434//',
      fetchImpl,
    })

    expect(calls[0]?.url).toBe('http://localhost:11434/api/tags')
    expect(models.map((m) => m.label)).toEqual(['custom:latest', 'qwen3:8b (8.2B)'])
    expect(models[1]).toMatchObject({
      id: 'qwen3:8b',
      provider: 'ollama',
      inputModalities: ['text'],
      outputModalities: ['text'],
      createdAt: '2025-06-01T10:00:00Z',
    })
  })
})

describe('listModels – errors', () => {
  it('rejects malformed responses with a German message', async () => {
    const { fetchImpl } = fakeFetch(() => json({ nope: true }))
    await expect(
      listModels({ ...base, provider: 'ollama', secret: undefined, fetchImpl }),
    ).rejects.toThrow('Unerwartetes Antwortformat')
  })
})

describe('testConnection', () => {
  it('maps HTTP 401 to "API-Key ungültig"', async () => {
    const { fetchImpl } = fakeFetch(() => json({ error: 'unauthorized' }, 401))
    const result = await testConnection({
      ...base,
      provider: 'anthropic',
      secret: 'bad',
      fetchImpl,
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('API-Key ungültig')
    expect(result.modelCount).toBeUndefined()
  })

  it('maps HTTP 403 to "API-Key ungültig"', async () => {
    const { fetchImpl } = fakeFetch(() => json({}, 403))
    const result = await testConnection({
      ...base,
      provider: 'openrouter',
      secret: 'bad',
      fetchImpl,
    })
    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('API-Key ungültig')
  })

  it('reports a missing key without throwing', async () => {
    const result = await testConnection({ ...base, provider: 'anthropic', secret: undefined })
    expect(result).toEqual({ ok: false, message: 'Kein Anthropic API-Key hinterlegt.' })
  })

  it('reports network errors as "Keine Verbindung zu …"', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const result = await testConnection({
      ...base,
      provider: 'ollama',
      secret: undefined,
      fetchImpl,
    })
    expect(result.ok).toBe(false)
    expect(result.message).toBe('Keine Verbindung zu Ollama (http://localhost:11434).')
  })

  it('reports other HTTP errors with the status', async () => {
    const { fetchImpl } = fakeFetch(() => json({}, 500))
    const result = await testConnection({ ...base, provider: 'openrouter', secret: 'k', fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('HTTP 500')
  })

  it('returns ok with the model count on success', async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], has_more: false }),
    )
    const result = await testConnection({ ...base, provider: 'anthropic', secret: 'k', fetchImpl })
    expect(result.ok).toBe(true)
    expect(result.modelCount).toBe(3)
    expect(result.message).toContain('3 Modelle')
  })
})
