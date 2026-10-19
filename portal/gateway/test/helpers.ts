import { randomUUID } from 'node:crypto'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { loadConfig, type Config } from '../src/config.js'
import { connectDatabase, type Database } from '../src/db.js'
import { buildApp } from '../src/server.js'
import { totpCode } from '../src/security.js'
import { bootstrapAdmin } from '../src/users.js'

export const ADMIN_USERNAME = 'chef'
export const ADMIN_PASSWORD = 'very-secret-admin-password'

export interface TestEnv {
  config: Config
  db: Database
  app: FastifyInstance
  close(): Promise<void>
}

/** Fresh databases per test file on the MongoDB from the test stack (or MONGO_URL). */
export async function createTestEnv(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const suffix = randomUUID().slice(0, 8)
  const config = loadConfig({
    PUBLIC_URL: 'http://localhost:3080',
    MONGO_URI: process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017',
    PORTAL_DB: `portal_test_${suffix}`,
    LIBRECHAT_DB: `librechat_test_${suffix}`,
    PORTAL_SECRET: 'test-secret-test-secret-test-secret-1234',
    OIDC_CLIENT_SECRET: 'test-client-secret',
    PORTAL_MCP_TOKEN: 'test-mcp-token',
    COOKIE_SECURE: 'false',
    USER_EMAIL_DOMAIN: 'users.test',
    ...overrides,
  })
  const db = await connectDatabase(config)
  await bootstrapAdmin(db, ADMIN_USERNAME, ADMIN_PASSWORD)
  const app = await buildApp({ config, db })
  return {
    config,
    db,
    app,
    async close() {
      await app.close()
      await db.portal.dropDatabase()
      await db.librechat.dropDatabase()
      await db.close()
    },
  }
}

/** Collects Set-Cookie headers into a Cookie header value. */
export function cookiesFrom(res: LightMyRequestResponse, jar: Record<string, string> = {}): Record<string, string> {
  for (const c of res.cookies) {
    if (c.value === '' || (c.maxAge !== undefined && c.maxAge <= 0)) delete jar[c.name]
    else jar[c.name] = c.value
  }
  return jar
}

export function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

export function form(data: Record<string, string>): { payload: string; headers: Record<string, string> } {
  return {
    payload: new URLSearchParams(data).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }
}

/** Logs the bootstrap admin in (password; TOTP too when ADMIN_TOTP is on) and returns the cookie jar. */
export async function loginAdmin(env: TestEnv): Promise<Record<string, string>> {
  const jar: Record<string, string> = {}
  const step1 = await env.app.inject({
    method: 'POST',
    url: '/portal/admin/login',
    ...form({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD, returnTo: '' }),
  })
  cookiesFrom(step1, jar)
  if (!jar.portal_sid && step1.headers.location?.startsWith('/portal/admin/totp')) {
    // Each TOTP code works once; tests log in more often than every 30 s, so forget the last one
    const admin = await env.db.col.users.findOneAndUpdate({ username: ADMIN_USERNAME }, { $unset: { totpLastStep: '' } })
    const secret = admin!.totpSecret ?? admin!.totpPendingSecret!
    const step2 = await env.app.inject({
      method: 'POST',
      url: '/portal/admin/totp',
      ...form({ code: totpCode(secret), returnTo: '' }),
      headers: { ...form({}).headers, cookie: cookieHeader(jar) },
    })
    cookiesFrom(step2, jar)
  }
  if (!jar.portal_sid) throw new Error(`admin login failed: ${step1.statusCode} ${step1.body.slice(0, 200)}`)
  return jar
}

/** Extracts the CSRF token from an admin page. */
export function csrfFrom(body: string): string {
  const match = body.match(/name="_csrf" value="([^"]+)"/)
  if (!match) throw new Error('no CSRF token on page')
  return match[1]!
}
