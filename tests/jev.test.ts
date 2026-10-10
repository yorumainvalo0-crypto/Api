import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/schemas/settings'
import { formatJevResponse, JevClient, JevQuestionSchema } from '../src/main/jev/client'
import { jevClientFromSettings } from '../src/main/jev/config'
import { SecretStore } from '../src/main/storage/secret-store'
import { startMockJev, type MockJev } from '../scripts/mock-jev'

describe('Jev client', () => {
  let mock: MockJev
  beforeAll(async () => {
    mock = await startMockJev()
  })
  afterAll(() => mock.close())

  const client = (apiKey = 'ts-test-key') =>
    new JevClient({ source: 'typesafe', apiKey, endpoint: mock.url, retryDelayMs: 5 })

  it('sends typed questions and parses every answer type', async () => {
    const response = await client().evaluate(
      { ticket: 'Drucker brennt' },
      {
        team: { type: 'choice', instructions: 'Wer?', criteria: { it: 'IT', hr: null } },
        severity: { type: 'score', instructions: 'Wie schlimm?', criteria: ['low', 'mid', 'high'] },
        urgent: { type: 'noul', instructions: 'Dringend?' },
      },
    )
    expect(mock.requests.at(-1)).toMatchObject({
      auth: 'Bearer ts-test-key',
      body: { model: 'jev-latest', state: { ticket: 'Drucker brennt' } },
    })
    expect(response.answers['team']).toMatchObject({ type: 'choice', choice: 'it' })
    expect(response.answers['severity']).toMatchObject({ type: 'score', score: 1.6 })
    expect(response.answers['urgent']).toEqual({ type: 'noul', noul: 0.9234 })
    expect(JSON.parse(formatJevResponse(response))).toMatchObject({
      model: 'jev-1.13',
      answers: { urgent: { type: 'noul', p_yes: 0.923 }, team: { choice: 'it', confidence: 0.8 } },
    })
  })

  it('retries when rate limited or overloaded', async () => {
    mock.failNext(429, 1)
    const before = mock.requests.length
    await client().evaluate('x', { q: { type: 'noul', instructions: 'ok?' } })
    expect(mock.requests.length).toBe(before + 1)
  })

  it('reports errors in German', async () => {
    await expect(
      client('wrong').evaluate('x', { q: { type: 'noul', instructions: 'ok?' } }),
    ).rejects.toThrow('Jev über TypeSafe: API-Key ungültig oder fehlt – Invalid API key.')
    mock.failNext(529, 3)
    await expect(
      client().evaluate('x', { q: { type: 'noul', instructions: 'ok?' } }),
    ).rejects.toThrow('überlastet')
    await expect(
      new JevClient({ source: 'typesafe', apiKey: 'k', endpoint: 'http://127.0.0.1:1/x' }).evaluate(
        'x',
        {},
      ),
    ).rejects.toThrow('TypeSafe (Jev) ist nicht erreichbar.')
  })

  it('validates questions like the API', () => {
    expect(
      JevQuestionSchema.safeParse({ type: 'score', instructions: 'x', criteria: ['a'] }).success,
    ).toBe(false)
    expect(
      JevQuestionSchema.safeParse({ type: 'choice', instructions: 'x', criteria: {} }).success,
    ).toBe(false)
    expect(
      JevQuestionSchema.safeParse({ type: 'noul', instructions: { q: 'x', data: [1] } }).success,
    ).toBe(true)
    expect(JevQuestionSchema.safeParse({ type: 'boolean', instructions: 'x' }).success).toBe(false)
  })
})

describe('Jev configuration', () => {
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-jev-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('uses the key and default model of the chosen source', () => {
    const secrets = new SecretStore(join(dir, 's.json'), {
      isAvailable: () => true,
      encrypt: (s) => Buffer.from(s),
      decrypt: (b) => b.toString(),
    })
    expect(jevClientFromSettings(DEFAULT_SETTINGS, secrets)).toEqual({
      reason: 'Kein TypeSafe-API-Key gespeichert.',
    })
    secrets.set('typesafe', 'ts-key')
    const direct = jevClientFromSettings(DEFAULT_SETTINGS, secrets)
    expect('client' in direct && direct.client.model).toBe('jev-latest')
    expect(secrets.status().typesafe).toBe(true)

    const viaOpenRouter = { ...DEFAULT_SETTINGS, jevSource: 'openrouter' as const }
    expect(jevClientFromSettings(viaOpenRouter, secrets)).toEqual({
      reason: 'Kein OpenRouter-API-Key gespeichert.',
    })
    secrets.set('openrouter', 'or-key')
    const routed = jevClientFromSettings(
      { ...viaOpenRouter, jevModel: 'typesafe/jev-1.13' },
      secrets,
    )
    expect('client' in routed && routed.client.model).toBe('typesafe/jev-1.13')
  })
})
