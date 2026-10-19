// Shared helpers for the end-to-end tests against the local test stack.
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MongoClient } from 'mongodb'
import { chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
export const STACK_DIR = resolve(here, '..')
export const LIBRECHAT_URL = process.env.LIBRECHAT_URL ?? 'http://127.0.0.1:3080'
export const MOCKS_URL = process.env.MOCKS_URL ?? 'http://127.0.0.1:8089'
export const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017'
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
    return await fn(client.db('LibreChat'), client)
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
  return chromium.launch({ executablePath: CHROMIUM, headless: true })
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

/** Log in through LibreChat's own password form (used until the gateway exists). */
export async function passwordLogin(page, email, password) {
  await page.goto(`${LIBRECHAT_URL}/login`)
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', password)
  await page.click('button[type="submit"]')
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

/** Log in through LibreChat's REST API and return the bearer token. */
export async function apiLogin(email, password) {
  const res = await fetch(`${LIBRECHAT_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`)
  return (await res.json()).token
}

/** Type a prompt into the chat composer and send it. */
export async function sendPrompt(page, text) {
  const input = page.locator('#prompt-textarea, [data-testid="text-input"]').first()
  await input.waitFor({ timeout: 30_000 })
  await input.fill(text)
  await page.keyboard.press('Enter')
}
