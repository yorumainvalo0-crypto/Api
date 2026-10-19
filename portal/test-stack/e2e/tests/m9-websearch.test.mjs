// Web search: Anthropic's own search tool is on by default; the gateway bills 0.01 USD per search.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  CREDITS_PER_USD,
  MOCKS_URL,
  USER_EMAIL_DOMAIN,
  adminLogin,
  createUserWithLoginLink,
  launchBrowser,
  librechatScript,
  loginWithLink,
  mockRequests,
  newDevice,
  sendPrompt,
  waitFor,
  withMongo,
} from '../lib.mjs'

const USERNAME = `suche${Date.now() % 100000}`
let browser
let page

async function searchCharges() {
  return withMongo(async (lc) => {
    const user = await lc.collection('users').findOne({ username: USERNAME })
    return lc.collection('transactions').find({ user: user._id, context: 'media', mediaKind: 'search' }).toArray()
  })
}

before(async () => {
  browser = await launchBrowser()
  const admin = await newDevice(browser)
  await adminLogin(admin.page)
  const link = await createUserWithLoginLink(admin.page, USERNAME)
  ;({ page } = await newDevice(browser))
  await loginWithLink(page, link)
  librechatScript('add-balance', '--', `${USERNAME}@${USER_EMAIL_DOMAIN}`, String(5 * CREDITS_PER_USD))
  await admin.context.close()
})

after(async () => {
  await fetch(`${MOCKS_URL}/__scenarios`, { method: 'DELETE' })
  await browser?.close()
})

test('Claude may search the web and each search costs 0.01 USD from the budget', async () => {
  await fetch(`${MOCKS_URL}/__scenarios`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trigger: 'AKTUELL_SUCHEN', webSearch: ['Wetter Berlin', 'Wetter Hamburg'], reply: 'Laut Suche ist es sonnig.' }),
  })
  await sendPrompt(page, 'AKTUELL_SUCHEN: Wie ist das Wetter?')
  await page.getByText('Laut Suche ist es sonnig.').first().waitFor({ timeout: 90_000 })

  // The search tool is offered to Claude on every chat request
  const request = (await mockRequests()).filter((r) => r.body?.stream).pop()
  assert.ok(request.body.tools.some((t) => t.type?.startsWith('web_search_') && t.name === 'web_search'))

  const message = await withMongo(async (lc) => {
    const user = await lc.collection('users').findOne({ username: USERNAME })
    return lc.collection('messages').find({ user: String(user._id), isCreatedByUser: false }).sort({ createdAt: -1 }).limit(1).next()
  })
  // LibreChat keeps each search as a tool call; the gateway bills these
  assert.equal(message.content.filter((p) => p.type === 'tool_call' && p.tool_call.name === 'web_search').length, 2)

  await waitFor(async () => (await searchCharges()).length > 0, { message: 'search charged', timeoutMs: 30_000 })
  const charges = await searchCharges()
  assert.equal(charges.length, 1)
  assert.equal(charges[0].tokenValue, -2 * 0.01 * CREDITS_PER_USD)
  assert.equal(charges[0].model, 'web_search')
})
