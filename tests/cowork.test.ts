import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_COWORK_ROLES,
  DEFAULT_SETTINGS,
  SettingsPatchSchema,
} from '@shared/schemas/settings'
import { JevClient } from '../src/main/jev/client'
import { applyRole, routeRequest } from '../src/main/cowork/router'
import { coworkBrief } from '../src/main/cowork/brief'
import { startMockJev, type MockJev } from '../scripts/mock-jev'

describe('Cowork routing', () => {
  let jev: MockJev
  beforeAll(async () => {
    jev = await startMockJev()
  })
  afterAll(() => jev.close())

  const client = () =>
    new JevClient({ source: 'typesafe', apiKey: 'ts-test-key', endpoint: jev.url, retryDelayMs: 5 })

  it('lets Jev pick a role from the role descriptions and asks whether to split', async () => {
    const decision = await routeRequest({
      prompt: 'Übersetze „Hallo“ ins Englische',
      attachmentNames: [],
      mode: 'chat',
      roles: DEFAULT_COWORK_ROLES,
      defaultRoleId: 'standard',
      jev: client(),
      subagents: true,
    })
    const sent = jev.requests.at(-1)?.body
    expect(Object.keys(sent?.questions ?? {})).toEqual(['role', 'split'])
    expect(sent?.questions['role']?.criteria).toEqual(
      Object.fromEntries(DEFAULT_COWORK_ROLES.map((r) => [r.id, r.description])),
    )
    // The mock answers with the first option.
    expect(decision).toMatchObject({
      by: 'jev',
      role: { id: 'schnell' },
      confidence: 0.8,
      splitProbability: 0.9234,
      usage: { input_tokens: 42 },
    })
  })

  it('falls back to the default role without Jev or when Jev fails', async () => {
    const base = {
      prompt: 'x',
      attachmentNames: [],
      mode: 'code' as const,
      roles: DEFAULT_COWORK_ROLES,
      defaultRoleId: 'experte',
      subagents: false,
    }
    expect(await routeRequest({ ...base, jev: undefined })).toMatchObject({
      by: 'default',
      role: { id: 'experte' },
      note: 'Jev ist nicht aktiv – Standardrolle verwendet.',
    })
    jev.failNext(401, 1)
    const failed = await routeRequest({
      ...base,
      jev: new JevClient({ source: 'typesafe', apiKey: 'wrong', endpoint: jev.url }),
    })
    expect(failed.by).toBe('default')
    expect(failed.note).toContain('Jev-Routing fehlgeschlagen')
  })

  it('applies the role to the settings and briefs the coordinator', () => {
    const role = DEFAULT_COWORK_ROLES.find((r) => r.id === 'experte')
    if (!role) throw new Error('default role missing')
    const applied = applyRole(DEFAULT_SETTINGS, role)
    expect(applied).toMatchObject({
      activeProvider: 'anthropic',
      effort: 'high',
      models: { anthropic: 'claude-opus-5-5' },
    })
    const brief = coworkBrief(
      { role, by: 'jev', confidence: 0.91, splitProbability: 0.3, note: null, usage: null },
      DEFAULT_COWORK_ROLES,
      true,
    )
    expect(brief).toContain(
      'Jev (TypeSafe) hat diese Anfrage der Rolle „Experte“ zugewiesen (Sicherheit 91 %)',
    )
    expect(brief).toContain('mcp__cowork__delegate')
    expect(brief).toContain('- schnell – Schnell (claude-haiku-5-5, Effort Niedrig)')
    expect(brief).toContain('30 %')
  })

  it('validates roles coming from the renderer', () => {
    expect(SettingsPatchSchema.safeParse({ coworkRoles: [] }).success).toBe(false)
    expect(
      SettingsPatchSchema.safeParse({
        coworkRoles: [DEFAULT_COWORK_ROLES[0], DEFAULT_COWORK_ROLES[0]],
      }).success,
    ).toBe(false)
    expect(
      SettingsPatchSchema.safeParse({
        coworkRoles: [{ ...DEFAULT_COWORK_ROLES[0], id: 'Mit Leerzeichen' }],
      }).success,
    ).toBe(false)
  })
})
