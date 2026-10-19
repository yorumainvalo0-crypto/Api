// Shared helpers for the end-to-end tests against the local test stack (./up.sh).
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MongoClient } from 'mongodb'
import { chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
export const STACK_DIR = resolve(here, '..')
/** Public URL as in production: nginx with TLS in front of LibreChat and the gateway */
export const PUBLIC_URL = 'https://portal.test:8443'
export const MOCKS_URL = process.env.MOCKS_URL ?? 'http://127.0.0.1:8089'
export const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017'
export const ADMIN = { username: 'chef', password: 'test-admin-password' }
export const USER_EMAIL_DOMAIN = 'users.portal.test'
const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

// 1 USD = 1,000,000 LibreChat credits
export const CREDITS_PER_USD = 1_000_000

export function compose(...args) {
  return execFileSync('docker', ['compose', ...args], { cwd: STACK_DIR, encoding: 'utf8' })
}

/** Run one of LibreChat's npm admin scripts inside the api container. */
export function librechatScript(...args) {
  return compose('exec', '-T', 'api', 'npm', 'run', ...args)
}

export async function withMongo(fn) {
  const client = new MongoClient(MONGO_URL)
  await client.connect()
  try {
    return await fn(client.db('LibreChat'), client.db('portal'))
  } finally {
    await client.close()
  }
}

export async function mockRequests() {
  const res = await fetch(`${MOCKS_URL}/__requests`)
  return res.json()
}

export async function clearMockRequests() {
  await fetch(`${MOCKS_URL}/__requests`, { method: 'DELETE' })
}

export async function launchBrowser() {
  return chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    // portal.test resolves to the local nginx, like a real domain would
    // Local stack: never use the environment's HTTP proxy
    args: ['--host-resolver-rules=MAP portal.test 127.0.0.1', '--no-proxy-server'],
  })
}

/** A separate browser profile = a separate device. */
export async function newDevice(browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } })
  return { context, page: await context.newPage() }
}

export async function waitFor(check, { timeoutMs = 30_000, intervalMs = 500, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** RFC 6238 TOTP code, as an authenticator app would show it. */
export function totp(secret, timeMs = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const c of secret) bits += alphabet.indexOf(c).toString(2).padStart(5, '0')
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30_000)))
  const digest = createHmac('sha1', key).update(counter).digest()
  const offset = digest[digest.length - 1] & 0x0f
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

/** Admin login in the gateway: password, then TOTP (enrolls on first login). */
export async function adminLogin(page) {
  await page.goto(`${PUBLIC_URL}/portal/admin/login`)
  await page.fill('#username', ADMIN.username)
  await page.fill('#password', ADMIN.password)
  await page.click('button[type="submit"]')
  await page.waitForURL(/\/portal\/admin\/totp/)
  const admin = await withMongo((_lc, portal) => portal.collection('users').findOne({ username: ADMIN.username }))
  await page.fill('#code', totp(admin.totpSecret ?? admin.totpPendingSecret))
  await page.click('button[type="submit"]')
  await page.waitForURL(`${PUBLIC_URL}/portal/admin`)
}

/** Creates a user in the admin area and returns a fresh login link for it. */
export async function createUserWithLoginLink(adminPage, username, { startBudgetUsd = 0, monthlyBudgetUsd = 0 } = {}) {
  await adminPage.goto(`${PUBLIC_URL}/portal/admin`)
  await adminPage.fill('#username', username)
  await adminPage.fill('#startBudgetUsd', String(startBudgetUsd))
  await adminPage.fill('#monthlyBudgetUsd', String(monthlyBudgetUsd))
  await adminPage.click('form[action="/portal/admin/users"] button[type="submit"]')
  await adminPage.waitForURL(/\/portal\/admin\/users\//)
  return newLoginLink(adminPage)
}

/** On a user's admin page: create a login QR and return its URL. */
export async function newLoginLink(adminPage, { note = '', maxUses = 1 } = {}) {
  await adminPage.fill('#note', note)
  await adminPage.fill('#maxUses', String(maxUses))
  await adminPage.click('form[action$="/login-links"] button[type="submit"]')
  await adminPage.waitForURL(/\?qr=/)
  await adminPage.locator('.qr svg').first().waitFor()
  return (await adminPage.locator('#login-link').innerText()).trim()
}

/** Scans a login QR on a device: lands logged in in the LibreChat chat. */
export async function loginWithLink(page, url) {
  await page.goto(url)
  await page.waitForURL(/\/c\//, { timeout: 30_000 })
  await acceptTerms(page)
}

/** Accept the terms-of-service modal that LibreChat shows on first login. */
export async function acceptTerms(page) {
  const accept = page.getByRole('button', { name: 'I accept' })
  try {
    await accept.waitFor({ timeout: 10_000 })
    await accept.click()
  } catch {
    // Already accepted earlier
  }
}

/** Type a prompt into the chat composer and send it. */
export async function sendPrompt(page, text) {
  const input = page.locator('#prompt-textarea, [data-testid="text-input"]').first()
  await input.waitFor({ timeout: 30_000 })
  await input.fill(text)
  await page.keyboard.press('Enter')
}
