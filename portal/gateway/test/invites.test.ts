import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createGroup,
  createInvite,
  formatBerlinLocal,
  inviteState,
  joinWithInvite,
  parseBerlinLocal,
} from '../src/invites.js'
import { createUser } from '../src/users.js'
import { type TestEnv, cookieHeader, createTestEnv, csrfFrom, loginAdmin } from './helpers.js'

let env: TestEnv
let groupId: string

beforeAll(async () => {
  env = await createTestEnv()
  groupId = (await createGroup(env.db, { name: 'Workshop', defaultStartBudgetUsd: 5, defaultMonthlyBudgetUsd: 5, createdBy: 'test' }))._id
})

afterAll(async () => {
  await env.close()
})

const hour = 3_600_000

function invite(overrides: Partial<Parameters<typeof createInvite>[2]> = {}) {
  return createInvite(env.db, env.config.PORTAL_SECRET, {
    groupId,
    maxUses: 3,
    validFrom: new Date(Date.now() - hour),
    validUntil: new Date(Date.now() + hour),
    startBudgetUsd: 2,
    monthlyBudgetUsd: 4,
    note: '',
    createdBy: 'test',
    ...overrides,
  })
}

describe('invites', () => {
  it('lets exactly as many people join as there are seats, even when they scan at the same time', async () => {
    const { token, invite: created } = await invite({ maxUses: 3 })
    const results = await Promise.all(['ella', 'finn', 'gina', 'hugo', 'ida'].map((name) => joinWithInvite(env.db, token, name)))
    const joined = results.filter((r) => r.ok)
    expect(joined).toHaveLength(3)
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'full')).toBe(true)
    const stored = await env.db.col.invites.findOne({ _id: created._id })
    expect(stored!.uses).toBe(3)
    expect(inviteState(stored!)).toBe('full')

    // Joined users carry the group and the invite's budgets
    const user = joined[0]!.ok ? joined[0]!.user : null
    expect(user).toMatchObject({ groupId, pendingStartBudgetUsd: 2, monthlyBudgetUsd: 4, role: 'user' })
  })

  it('only works inside the time window and until revoked', async () => {
    const early = await invite({ validFrom: new Date(Date.now() + hour), validUntil: new Date(Date.now() + 2 * hour) })
    expect(await joinWithInvite(env.db, early.token, 'zu-frueh')).toEqual({ ok: false, reason: 'not-yet' })

    const late = await invite()
    await env.db.col.invites.updateOne({ _id: late.invite._id }, { $set: { validUntil: new Date(Date.now() - 1000) } })
    expect(await joinWithInvite(env.db, late.token, 'zu-spaet')).toEqual({ ok: false, reason: 'expired' })

    const revoked = await invite()
    await env.db.col.invites.updateOne({ _id: revoked.invite._id }, { $set: { revokedAt: new Date() } })
    expect(await joinWithInvite(env.db, revoked.token, 'widerrufen')).toEqual({ ok: false, reason: 'revoked' })

    expect(await joinWithInvite(env.db, 'unknown-token', 'niemand')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('gives the seat back when the username is taken or invalid', async () => {
    await createUser(env.db, { username: 'vergeben' })
    const { token, invite: created } = await invite({ maxUses: 1 })
    const taken = await joinWithInvite(env.db, token, 'Vergeben')
    expect(taken.ok).toBe(false)
    expect(!taken.ok && taken.reason).toBe('username')
    const invalid = await joinWithInvite(env.db, token, 'a b')
    expect(!invalid.ok && invalid.reason).toBe('username')
    expect((await env.db.col.invites.findOne({ _id: created._id }))!.uses).toBe(0)
    expect((await joinWithInvite(env.db, token, 'frei')).ok).toBe(true)
  })

  it('rejects windows that end before they start or lie in the past', async () => {
    await expect(invite({ validFrom: new Date(), validUntil: new Date(Date.now() - 1) })).rejects.toThrow('Ende')
    await expect(invite({ validFrom: new Date(Date.now() - 2 * hour), validUntil: new Date(Date.now() - hour) })).rejects.toThrow(
      'Vergangenheit',
    )
  })
})

describe('Berlin local time', () => {
  it('converts summer and winter times', () => {
    expect(parseBerlinLocal('2026-07-01T12:00')!.toISOString()).toBe('2026-07-01T10:00:00.000Z')
    expect(parseBerlinLocal('2026-12-01T12:00')!.toISOString()).toBe('2026-12-01T11:00:00.000Z')
    expect(formatBerlinLocal(new Date('2026-12-01T11:00:00Z'))).toBe('2026-12-01T12:00')
    expect(parseBerlinLocal('kein datum')).toBeNull()
  })
})

describe('admin pages and join flow over HTTP', () => {
  it('admin creates a group and an invite; a person joins with a chosen username', async () => {
    const jar = await loginAdmin(env)
    const headers = { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) }
    const groupsPage = await env.app.inject({ url: '/portal/admin/groups', headers: { cookie: cookieHeader(jar) } })
    const csrf = csrfFrom(groupsPage.body)

    const created = await env.app.inject({
      method: 'POST',
      url: '/portal/admin/groups',
      headers,
      payload: new URLSearchParams({ _csrf: csrf, name: 'Familie', defaultStartBudgetUsd: '3', defaultMonthlyBudgetUsd: '3' }).toString(),
    })
    const groupUrl = created.headers.location as string
    const now = new Date()
    const inviteRes = await env.app.inject({
      method: 'POST',
      url: `${groupUrl}/invites`,
      headers,
      payload: new URLSearchParams({
        _csrf: csrf,
        maxUses: '2',
        validFrom: formatBerlinLocal(new Date(now.getTime() - 60_000)),
        validUntil: formatBerlinLocal(new Date(now.getTime() + 2 * hour)),
        startBudgetUsd: '3',
        monthlyBudgetUsd: '3',
        note: 'Geburtstag',
      }).toString(),
    })
    expect(inviteRes.statusCode).toBe(302)
    const shown = await env.app.inject({ url: inviteRes.headers.location as string, headers: { cookie: cookieHeader(jar) } })
    expect(shown.body).toContain('<svg')
    const link = shown.body.match(/<code id="invite-link">([^<]+)<\/code>/)![1]!
    const path = new URL(link).pathname

    const joinPage = await env.app.inject({ url: path })
    expect(joinPage.statusCode).toBe(200)
    expect(joinPage.body).toContain('Familie')

    const joined = await env.app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=Lena.M',
    })
    expect(joined.statusCode).toBe(302)
    expect(joined.headers.location).toBe('http://localhost:3080/')
    expect(joined.cookies.find((c) => c.name === 'portal_sid')).toBeTruthy()
    expect(await env.db.col.users.findOne({ username: 'lena.m' })).toMatchObject({ pendingStartBudgetUsd: 3 })

    // The group page lists the new member and the invite with 1 of 2 seats used
    const after = await env.app.inject({ url: groupUrl, headers: { cookie: cookieHeader(jar) } })
    expect(after.body).toContain('lena.m')
    expect(after.body).toContain('1 / 2')
  })
})
