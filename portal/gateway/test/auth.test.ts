import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLoginLink, redeemLoginLink } from '../src/login-links.js'
import { totpCode } from '../src/security.js'
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
    // Opening the link (or a messenger's link preview) only shows a button and uses nothing up
    for (let i = 0; i < 2; i++) {
      const preview = await env.app.inject({ url: `/portal/l/${token}` })
      expect(preview.statusCode).toBe(200)
      expect(preview.body).toContain('id="login-confirm"')
      expect(preview.cookies.find((c) => c.name === 'portal_sid')).toBeUndefined()
    }
    const res = await env.app.inject({
      method: 'POST',
      url: `/portal/l/${token}`,
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Safari/604.1' },
    })
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('http://localhost:3080/')
    const cookie = res.cookies.find((c) => c.name === 'portal_sid')
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.path).toBe('/portal')
    const devices = await env.db.col.devices.find({ userId: user._id }).toArray()
    expect(devices).toHaveLength(1)
    expect(devices[0]!.label).toBe('Handy')

    for (const method of ['GET', 'POST'] as const) {
      const again = await env.app.inject({ method, url: `/portal/l/${token}` })
      expect(again.statusCode).toBe(410)
      expect(again.body).toContain('schon benutzt')
    }
  })
})

describe('admin login', () => {
  it('logs admins in with the password alone by default; admin pages stay closed without it', async () => {
    const anonymous = await env.app.inject({ url: '/portal/admin' })
    expect(anonymous.statusCode).toBe(302)
    expect(anonymous.headers.location).toBe('/portal/admin/login')

    const wrong = await env.app.inject({
      method: 'POST',
      url: '/portal/admin/login',
      ...form({ username: ADMIN_USERNAME, password: 'wrong-password', returnTo: '' }),
    })
    expect(wrong.statusCode).toBe(401)
    expect(wrong.cookies.find((c) => c.name === 'portal_sid')).toBeUndefined()

    const adminJar = await loginAdmin(env)
    const page = await env.app.inject({ url: '/portal/admin', headers: { cookie: cookieHeader(adminJar) } })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Benutzer direkt anlegen')
    const admin = await env.db.col.users.findOne({ username: ADMIN_USERNAME })
    expect(admin!.totpSecret).toBeNull()
  })

  it('locks an account for 15 minutes after 10 wrong passwords', async () => {
    const own = await createTestEnv({ ADMIN_LOGIN_RATE_LIMIT: '100' })
    try {
      const attempt = (password: string) =>
        own.app.inject({ method: 'POST', url: '/portal/admin/login', ...form({ username: ADMIN_USERNAME, password, returnTo: '' }) })
      for (let i = 0; i < 10; i++) expect((await attempt('wrong-password')).statusCode).toBe(401)
      const locked = await attempt(ADMIN_PASSWORD)
      expect(locked.statusCode).toBe(429)
      expect(locked.body).toContain('15 Minuten')
    } finally {
      await own.close()
    }
  })

  it('with ADMIN_TOTP on: password plus a one-time code, locked after repeated wrong codes', async () => {
    // Own instance: this test alone sends more TOTP posts than the default rate limit allows
    const own = await createTestEnv({ ADMIN_LOGIN_RATE_LIMIT: '100', ADMIN_TOTP: 'true' })
    const passwordStep = async () => {
      const jar: Record<string, string> = {}
      cookiesFrom(
        await own.app.inject({
          method: 'POST',
          url: '/portal/admin/login',
          ...form({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD, returnTo: '' }),
        }),
        jar,
      )
      return jar
    }
    const sendCode = async (jar: Record<string, string>, code: string) =>
      own.app.inject({
        method: 'POST',
        url: '/portal/admin/totp',
        ...form({ code, returnTo: '' }),
        headers: { ...form({}).headers, cookie: cookieHeader(jar) },
      })

    // Password alone gives no session
    const first = await passwordStep()
    expect(first.portal_sid).toBeUndefined()
    expect((await sendCode(first, '000000')).statusCode).toBe(401)

    await loginAdmin(own)
    const admin = await own.db.col.users.findOne({ username: ADMIN_USERNAME })
    expect(admin!.totpSecret).toBeTruthy()
    const usedCode = totpCode(admin!.totpSecret!, admin!.totpLastStep! * 30_000)

    const jar = await passwordStep()
    const replay = await sendCode(jar, usedCode)
    expect(replay.statusCode).toBe(401)
    expect(replay.body).toContain('schon benutzt')

    await own.db.col.audit.deleteMany({ action: 'admin.totp.failed' })
    for (let i = 0; i < 5; i++) expect((await sendCode(jar, '000000')).statusCode).toBe(401)
    const locked = await sendCode(jar, totpCode(admin!.totpSecret!, Date.now() + 30_000))
    expect(locked.statusCode).toBe(429)
    expect(locked.body).toContain('15 Minuten')
    await own.close()
  })

  it('logout needs the CSRF token and ends the device session for good', async () => {
    const jar = await loginAdmin(env)
    const page = await env.app.inject({ url: '/portal/admin', headers: { cookie: cookieHeader(jar) } })
    const forged = await env.app.inject({
      method: 'POST',
      url: '/portal/logout',
      ...form({}),
      headers: { ...form({}).headers, cookie: cookieHeader(jar) },
    })
    expect(forged.statusCode).toBe(403)
    const logout = await env.app.inject({
      method: 'POST',
      url: '/portal/logout',
      ...form({ _csrf: csrfFrom(page.body) }),
      headers: { ...form({}).headers, cookie: cookieHeader(jar) },
    })
    expect(logout.statusCode).toBe(302)
    // The old cookie value is worthless even if it was copied before
    const reused = await env.app.inject({ url: '/portal/admin', headers: { cookie: cookieHeader(jar) } })
    expect(reused.statusCode).toBe(302)
  })

  it('a normal user session cannot open the admin area', async () => {
    const user = await createUser(env.db, { username: 'normalo' })
    const { token } = await createLoginLink(env.db, { userId: user._id, createdBy: 'test', validHours: 1, maxUses: 1, note: '' })
    const jar = cookiesFrom(await env.app.inject({ method: 'POST', url: `/portal/l/${token}` }))
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

describe('users with a password', () => {
  it('the admin gives a person a password; they log in with it and land in the chat', async () => {
    const jar = await loginAdmin(env)
    const csrf = csrfFrom((await env.app.inject({ url: '/portal/admin', headers: { cookie: cookieHeader(jar) } })).body)
    const post = (url: string, data: Record<string, string>) =>
      env.app.inject({ method: 'POST', url, ...form({ _csrf: csrf, ...data }), headers: { ...form({}).headers, cookie: cookieHeader(jar) } })

    const tooShort = await post('/portal/admin/users', { username: 'kurz', password: 'abc' })
    expect(decodeURIComponent(String(tooShort.headers.location))).toContain('mindestens 10 Zeichen')
    expect(await env.db.col.users.findOne({ username: 'kurz' })).toBeNull()

    const created = await post('/portal/admin/users', { username: 'paula', password: 'sonnen-blume-42', startBudgetUsd: '1', monthlyBudgetUsd: '0' })
    expect(created.statusCode).toBe(302)
    const paula = await env.db.col.users.findOne({ username: 'paula' })
    expect(paula!.passwordHash).toMatch(/^scrypt\$/)

    const login = (password: string, url = '/portal/login') =>
      env.app.inject({ method: 'POST', url, ...form({ username: 'Paula', password, returnTo: '' }) })
    expect((await login('falsch-falsch')).statusCode).toBe(401)
    const ok = await login('sonnen-blume-42')
    expect(ok.statusCode).toBe(302)
    expect(ok.headers.location).toBe('http://localhost:3080/')
    const userJar = cookiesFrom(ok)
    expect((await env.app.inject({ url: '/portal/admin', headers: { cookie: cookieHeader(userJar) } })).statusCode).toBe(302)
    // The admin login does not accept normal users
    expect((await login('sonnen-blume-42', '/portal/admin/login')).statusCode).toBe(401)

    // Change and remove: the old password stops working, QR login is unaffected
    await post(`/portal/admin/users/${paula!._id}/password`, { password: 'neues-passwort-7' })
    expect((await login('sonnen-blume-42')).statusCode).toBe(401)
    expect((await login('neues-passwort-7')).statusCode).toBe(302)
    await post(`/portal/admin/users/${paula!._id}/password/remove`, {})
    expect((await login('neues-passwort-7')).statusCode).toBe(401)

    // Admins keep a password
    const admin = await env.db.col.users.findOne({ username: ADMIN_USERNAME })
    const removeAdmin = await post(`/portal/admin/users/${admin!._id}/password/remove`, {})
    expect(decodeURIComponent(String(removeAdmin.headers.location))).toContain('Admins brauchen ein Passwort')
  })

  it('a person without a device session can log in with the password on the chat login page', async () => {
    const res = await env.app.inject({ url: '/portal/login' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('name="password"')
    expect(res.body).toContain('QR-Code')
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
        // A forged X-Forwarded-For entry per request must not help: only the address nginx
        // appended (the last entry) counts
        const res = await limited.app.inject({
          method: 'POST',
          url: '/portal/admin/login',
          ...form({ username: ADMIN_USERNAME, password: 'wrong', returnTo: '' }),
          headers: { ...form({}).headers, 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` },
        })
        statuses.push(res.statusCode)
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429])
    } finally {
      await limited.close()
    }
  })
})
