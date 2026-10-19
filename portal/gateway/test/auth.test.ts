import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLoginLink, redeemLoginLink } from '../src/login-links.js'
import { createUser } from '../src/users.js'
import { ADMIN_PASSWORD, ADMIN_USERNAME, type TestEnv, cookieHeader, cookiesFrom, createTestEnv, csrfFrom, form, loginAdmin } from './helpers.js'

let env: TestEnv

beforeAll(async () => {
  env = await createTestEnv()
})

afterAll(async () => {
  await env.close()
})

describe('login links', () => {
  it('can be used exactly as often as allowed, even when scanned in parallel', async () => {
    const user = await createUser(env.db, { username: 'parallel' })
    const { token } = await createLoginLink(env.db, { userId: user._id, createdBy: 'test', validHours: 1, maxUses: 2, note: '' })
    const results = await Promise.all(Array.from({ length: 8 }, () => redeemLoginLink(env.db, token)))
    expect(results.filter((r) => r.ok)).toHaveLength(2)
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'used')).toBe(true)
  })

  it('rejects expired, revoked, unknown links and blocked users', async () => {
    const user = await createUser(env.db, { username: 'expired' })
    const expired = await createLoginLink(env.db, { userId: user._id, createdBy: 'test', validHours: 1, maxUses: 1, note: '' })
    await env.db.col.loginLinks.updateOne({ _id: expired.link._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await redeemLoginLink(env.db, expired.token)).toEqual({ ok: false, reason: 'expired' })

    const revoked = await createLoginLink(env.db, { userId: user._id, createdBy: 'test', validHours: 1, maxUses: 1, note: '' })
    await env.db.col.loginLinks.updateOne({ _id: revoked.link._id }, { $set: { revokedAt: new Date() } })
    expect(await redeemLoginLink(env.db, revoked.token)).toEqual({ ok: false, reason: 'revoked' })

    expect(await redeemLoginLink(env.db, 'does-not-exist')).toEqual({ ok: false, reason: 'invalid' })

    const blocked = await createLoginLink(env.db, { userId: user._id, createdBy: 'test', validHours: 1, maxUses: 1, note: '' })
    await env.db.col.users.updateOne({ _id: user._id }, { $set: { status: 'blocked' } })
    expect(await redeemLoginLink(env.db, blocked.token)).toEqual({ ok: false, reason: 'blocked' })
  })

  it('opening the QR link starts a device session and sends the person to the chat', async () => {
    const user = await createUser(env.db, { username: 'scanner' })
    const { token } = await createLoginLink(env.db, { userId: user._id, createdBy: 'test', validHours: 1, maxUses: 1, note: 'Handy' })
    const res = await env.app.inject({ url: `/portal/l/${token}`, headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Safari/604.1' } })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('http://localhost:3080/')
    const cookie = res.cookies.find((c) => c.name === 'portal_sid')
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.path).toBe('/portal')
    const devices = await env.db.col.devices.find({ userId: user._id }).toArray()
    expect(devices).toHaveLength(1)
    expect(devices[0]!.label).toBe('Handy')

    const again = await env.app.inject({ url: `/portal/l/${token}` })
    expect(again.statusCode).toBe(410)
    expect(again.body).toContain('schon benutzt')
  })
})

describe('admin login', () => {
  it('requires password and TOTP; admin pages are closed without both', async () => {
    const anonymous = await env.app.inject({ url: '/portal/admin' })
    expect(anonymous.statusCode).toBe(302)
    expect(anonymous.headers.location).toBe('/portal/admin/login')

    const wrong = await env.app.inject({
      method: 'POST',
      url: '/portal/admin/login',
      ...form({ username: ADMIN_USERNAME, password: 'wrong-password', returnTo: '' }),
    })
    expect(wrong.statusCode).toBe(401)

    // Password alone gives no session
    const jar: Record<string, string> = {}
    const step1 = await env.app.inject({
      method: 'POST',
      url: '/portal/admin/login',
      ...form({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD, returnTo: '' }),
    })
    cookiesFrom(step1, jar)
    expect(jar.portal_sid).toBeUndefined()
    const badCode = await env.app.inject({
      method: 'POST',
      url: '/portal/admin/totp',
      payload: 'code=000000&returnTo=',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    })
    expect(badCode.statusCode).toBe(401)

    const adminJar = await loginAdmin(env)
    const page = await env.app.inject({ url: '/portal/admin', headers: { cookie: cookieHeader(adminJar) } })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Benutzer direkt anlegen')
    const admin = await env.db.col.users.findOne({ username: ADMIN_USERNAME })
    expect(admin!.totpSecret).toBeTruthy()
  })

  it('a normal user session cannot open the admin area', async () => {
    const user = await createUser(env.db, { username: 'normalo' })
    const { token } = await createLoginLink(env.db, { userId: user._id, createdBy: 'test', validHours: 1, maxUses: 1, note: '' })
    const jar = cookiesFrom(await env.app.inject({ url: `/portal/l/${token}` }))
    const res = await env.app.inject({ url: '/portal/admin', headers: { cookie: cookieHeader(jar) } })
    expect(res.statusCode).toBe(302)
  })

  it('creates users and login QR codes, and rejects posts without CSRF token', async () => {
    const jar = await loginAdmin(env)
    const page = await env.app.inject({ url: '/portal/admin', headers: { cookie: cookieHeader(jar) } })
    const csrf = csrfFrom(page.body)

    const forged = await env.app.inject({
      method: 'POST',
      url: '/portal/admin/users',
      payload: new URLSearchParams({ username: 'forged' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    })
    expect(forged.statusCode).toBe(403)

    const created = await env.app.inject({
      method: 'POST',
      url: '/portal/admin/users',
      payload: new URLSearchParams({ _csrf: csrf, username: 'Maria', startBudgetUsd: '7.5', monthlyBudgetUsd: '5' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    })
    expect(created.statusCode).toBe(302)
    const maria = await env.db.col.users.findOne({ username: 'maria' })
    expect(maria).toMatchObject({ pendingStartBudgetUsd: 7.5, monthlyBudgetUsd: 5, role: 'user' })

    const linkRes = await env.app.inject({
      method: 'POST',
      url: `/portal/admin/users/${maria!._id}/login-links`,
      payload: new URLSearchParams({ _csrf: csrf, validHours: '2', maxUses: '1', note: 'Tablet' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    })
    expect(linkRes.statusCode).toBe(302)
    const detail = await env.app.inject({ url: linkRes.headers.location as string, headers: { cookie: cookieHeader(jar) } })
    expect(detail.body).toContain('<svg')
    const url = detail.body.match(/<code id="login-link">([^<]+)<\/code>/)![1]!
    expect(url.startsWith('http://localhost:3080/portal/l/')).toBe(true)
    // The token is not stored in clear text
    const links = await env.db.col.loginLinks.find({ userId: maria!._id }).toArray()
    expect(JSON.stringify(links)).not.toContain(url.split('/').pop())
  })
})

describe('OIDC', () => {
  it('publishes discovery metadata for LibreChat', async () => {
    const res = await env.app.inject({
      url: '/portal/oidc/.well-known/openid-configuration',
      headers: { host: 'localhost:3080' },
    })
    expect(res.statusCode).toBe(200)
    const meta = res.json()
    expect(meta.issuer).toBe('http://localhost:3080/portal/oidc')
    expect(meta.authorization_endpoint).toBe('http://localhost:3080/portal/oidc/auth')
    expect(meta.claims_supported).toEqual(expect.arrayContaining(['preferred_username', 'email', 'roles']))
  })
})

describe('rate limits', () => {
  it('blocks repeated admin login attempts from one IP', async () => {
    const limited = await createTestEnv({ ADMIN_LOGIN_RATE_LIMIT: '3' })
    try {
      const statuses: number[] = []
      for (let i = 0; i < 5; i++) {
        const res = await limited.app.inject({
          method: 'POST',
          url: '/portal/admin/login',
          ...form({ username: ADMIN_USERNAME, password: 'wrong', returnTo: '' }),
        })
        statuses.push(res.statusCode)
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429])
    } finally {
      await limited.close()
    }
  })
})
