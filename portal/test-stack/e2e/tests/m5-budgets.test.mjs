// M5: USD budgets – start budget from the invite, admin top-ups, konto_status tool.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  CREDITS_PER_USD,
  MOCKS_URL,
  PUBLIC_URL,
  acceptTerms,
  adminLogin,
  clearMockRequests,
  launchBrowser,
  mockRequests,
  newDevice,
  sendPrompt,
  waitFor,
  withMongo,
} from '../lib.mjs'

const suffix = Date.now() % 100000
let browser
let admin
let groupUrl

async function balanceOf(username) {
  return withMongo(async (lc) => {
    const user = await lc.collection('users').findOne({ username })
    const balance = user && (await lc.collection('balances').findOne({ user: user._id }))
    return (balance?.tokenCredits ?? 0) / CREDITS_PER_USD
  })
}

/** Admin creates an invite in a fresh group and returns its link. */
async function invite({ startBudgetUsd, monthlyBudgetUsd = 0 }) {
  if (!groupUrl) {
    await admin.page.goto(`${PUBLIC_URL}/portal/admin/groups`)
    await admin.page.fill('#name', `Budget ${suffix}`)
    await admin.page.click('form[action="/portal/admin/groups"] button[type="submit"]')
    await admin.page.waitForURL(/groups\/[0-9a-f-]+$/)
    groupUrl = admin.page.url()
  }
  await admin.page.goto(groupUrl)
  await admin.page.fill('#maxUses', '1')
  await admin.page.fill('#startBudgetUsd', String(startBudgetUsd))
  await admin.page.fill('#monthlyBudgetUsd', String(monthlyBudgetUsd))
  await admin.page.click('form[action$="/invites"] button[type="submit"]')
  await admin.page.locator('#invite-qr svg').waitFor()
  return (await admin.page.locator('#invite-link').innerText()).trim()
}

async function join(link, username) {
  const device = await newDevice(browser)
  await device.page.goto(link)
  await device.page.fill('#username', username)
  await device.page.click('button[type="submit"]')
  await device.page.waitForURL(/\/c\//, { timeout: 30_000 })
  await acceptTerms(device.page)
  return device
}

before(async () => {
  browser = await launchBrowser()
  admin = await newDevice(browser)
  await adminLogin(admin.page)
})

after(async () => {
  await fetch(`${MOCKS_URL}/__scenarios`, { method: 'DELETE' })
  await browser?.close()
})

test('the start budget of the invite is available right after joining', async () => {
  const name = `budget${suffix}`
  const { page } = await join(await invite({ startBudgetUsd: 2, monthlyBudgetUsd: 5 }), name)
  await waitFor(async () => (await balanceOf(name)) === 2, { message: 'start budget booked', timeoutMs: 15_000 })

  await sendPrompt(page, 'Hallo mit Startbudget')
  await page.getByText('Hallo vom Test-Claude.').first().waitFor({ timeout: 60_000 })
  // Opus 5.5 message (0.014 $) plus a Haiku title
  const remaining = await waitFor(async () => {
    const value = await balanceOf(name)
    return value < 2 - 0.014 + 1e-9 ? value : null
  }, { message: 'cost deducted' })
  assert.ok(remaining > 1.98 && remaining <= 1.986, `remaining ${remaining}`)
})

test('without budget the chat is blocked until the admin tops up', async () => {
  const name = `leer${suffix}`
  const { page } = await join(await invite({ startBudgetUsd: 0 }), name)
  await clearMockRequests()
  await sendPrompt(page, 'Ohne Guthaben')
  await page.getByText(/balance|guthaben|insufficient/i).first().waitFor({ timeout: 30_000 })
  assert.equal((await mockRequests()).filter((r) => r.body?.stream).length, 0)

  // Admin: Benutzer → Budget → Limit erweitern
  await admin.page.goto(`${PUBLIC_URL}/portal/admin`)
  await admin.page.click(`a:text-is("${name}")`)
  await admin.page.fill('#amountUsd', '1')
  await admin.page.click('form[action$="/topup"] button[type="submit"]')
  await admin.page.waitForURL(/#budget$/)
  assert.equal((await admin.page.locator('#remaining-usd').innerText()).trim(), '1.00 $')
  assert.equal(await balanceOf(name), 1)

  await page.goto(`${PUBLIC_URL}/c/new`)
  await sendPrompt(page, 'Jetzt mit Guthaben')
  await page.getByText('Hallo vom Test-Claude.').first().waitFor({ timeout: 60_000 })
})

test('Claude can tell people their remaining budget with the konto_status tool', async () => {
  const name = `konto${suffix}`
  const { page } = await join(await invite({ startBudgetUsd: 3, monthlyBudgetUsd: 5 }), name)
  await waitFor(async () => (await balanceOf(name)) === 3, { message: 'start budget booked', timeoutMs: 15_000 })
  await fetch(`${MOCKS_URL}/__scenarios`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trigger: 'WIE_VIEL_GUTHABEN', tool: 'konto_status_mcp_portal', input: {}, reply: 'Siehe Konto-Status.' }),
  })
  await clearMockRequests()
  await sendPrompt(page, 'WIE_VIEL_GUTHABEN habe ich noch?')
  await page.getByText('Siehe Konto-Status.').first().waitFor({ timeout: 60_000 })

  const followUp = (await mockRequests()).filter((r) => r.body?.stream).pop()
  const toolResult = JSON.stringify(followUp.body.messages)
  assert.match(toolResult, new RegExp(`Benutzer: ${name}`))
  // LibreChat books the cost of a turn after it finishes, so the tool still sees the full 3 $
  assert.match(toolResult, /Verbleibendes Guthaben: 3\.00 USD/)
  assert.match(toolResult, /Monatsbudget: 5\.00 USD/)
})
