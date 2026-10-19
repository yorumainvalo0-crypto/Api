// M1: LibreChat base – Claude only, default Opus 5.5 / medium effort, USD balance enforced.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  CREDITS_PER_USD,
  LIBRECHAT_URL,
  apiLogin,
  clearMockRequests,
  launchBrowser,
  librechatScript,
  mockRequests,
  passwordLogin,
  sendPrompt,
  waitFor,
  withMongo,
} from '../lib.mjs'

const EMAIL = `m1-${Date.now()}@example.com`
const PASSWORD = 'Test-Passw0rd-123'
// Opus 5.5: $4 / $20 per 1M tokens; the mock reports 1000 input and 500 output tokens
const EXPECTED_MESSAGE_COST_USD = (1000 * 4 + 500 * 20) / 1_000_000

let browser
let page

before(async () => {
  librechatScript('create-user', '--', EMAIL, 'M1 Tester', `m1user${Date.now()}`, PASSWORD, '--email-verified=true')
  browser = await launchBrowser()
  page = await browser.newPage()
})

after(async () => {
  await browser?.close()
})

test('startup config exposes only the Claude model specs, Opus 5.5 is the default', async () => {
  const token = await apiLogin(EMAIL, PASSWORD)
  const config = await (await fetch(`${LIBRECHAT_URL}/api/config`, { headers: { authorization: `Bearer ${token}` } })).json()
  const specs = config.modelSpecs?.list ?? []
  assert.deepEqual(
    specs.map((s) => s.preset.model),
    ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  )
  const defaults = specs.filter((s) => s.default)
  assert.equal(defaults.length, 1)
  assert.equal(defaults[0].preset.model, 'claude-opus-5-5')
  assert.equal(defaults[0].preset.effort, 'medium')
  assert.ok(specs.every((s) => s.preset.endpoint === 'anthropic'))
})

test('a new user starts with zero balance and is blocked', async () => {
  await passwordLogin(page, EMAIL, PASSWORD)
  const balance = await withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email: EMAIL })
    return db.collection('balances').findOne({ user: user._id })
  })
  assert.equal(balance?.tokenCredits ?? 0, 0)

  await clearMockRequests()
  await sendPrompt(page, 'Hallo?')
  // LibreChat rejects the request before it reaches Anthropic
  await page.getByText(/balance|guthaben|insufficient/i).first().waitFor({ timeout: 30_000 })
  const calls = (await mockRequests()).filter((r) => r.path.endsWith('/messages') && r.body?.stream)
  assert.equal(calls.length, 0, 'no chat request may reach Anthropic without balance')
})

test('after a top-up the chat uses Opus 5.5 with medium effort and the exact cost is booked', async () => {
  librechatScript('add-balance', '--', EMAIL, String(1 * CREDITS_PER_USD))
  await clearMockRequests()

  await page.goto(`${LIBRECHAT_URL}/c/new`)
  await sendPrompt(page, 'Sag Hallo')
  await page.getByText('Hallo vom Test-Claude.').first().waitFor({ timeout: 60_000 })

  const chatCalls = await waitFor(
    async () => {
      const calls = (await mockRequests()).filter(
        (r) =>
          r.path.endsWith('/messages') &&
          r.body?.stream &&
          JSON.stringify(r.body?.messages ?? '').includes('Sag Hallo'),
      )
      return calls.length ? calls : null
    },
    { message: 'chat request at the mock' },
  )
  const body = chatCalls[0].body
  assert.equal(body.model, 'claude-opus-5-5')
  assert.equal(body.output_config?.effort, 'medium')
  const toolNames = (body.tools ?? []).map((t) => t.name)
  for (const tool of ['bash_tool', 'create_file', 'skill']) {
    assert.ok(toolNames.includes(tool), `tool ${tool} missing: ${toolNames}`)
  }
  assert.ok(
    toolNames.some((name) => name.endsWith('_mcp_portal')),
    `portal MCP tools missing: ${toolNames}`,
  )

  const tx = await waitFor(
    () =>
      withMongo(async (db) => {
        const user = await db.collection('users').findOne({ email: EMAIL })
        const rows = await db.collection('transactions').find({ user: user._id, context: 'message' }).toArray()
        return rows.length >= 2 ? rows : null
      }),
    { message: 'message transactions' },
  )
  const costUsd = -tx.reduce((sum, row) => sum + row.tokenValue, 0) / CREDITS_PER_USD
  assert.ok(
    Math.abs(costUsd - EXPECTED_MESSAGE_COST_USD) < 1e-9,
    `booked ${costUsd} USD, expected ${EXPECTED_MESSAGE_COST_USD} USD`,
  )
  assert.ok(tx.every((row) => row.model === 'claude-opus-5-5'))
})

test('chat titles are generated with Haiku 5.5, not the chat model', async () => {
  const titleCalls = await waitFor(
    async () => {
      const calls = (await mockRequests()).filter((r) => r.path.endsWith('/messages') && !r.body?.stream)
      return calls.length ? calls : null
    },
    { message: 'title request at the mock' },
  )
  assert.ok(titleCalls.every((r) => r.body.model === 'claude-haiku-5-5'), titleCalls.map((r) => r.body.model).join())
})

test('users can raise the effort in the parameters panel', async () => {
  await clearMockRequests()
  await page.goto(`${LIBRECHAT_URL}/c/new`)
  await page.click('[data-testid="nav-panel-parameters"]')
  const slider = page.locator('[role="slider"]').nth(await effortSliderIndex(page))
  await slider.focus()
  // Effort levels: auto, low, medium, high, xhigh, max
  assert.equal(await slider.getAttribute('aria-valuenow'), '2', 'default effort must be medium')
  await page.keyboard.press('ArrowRight')
  await waitFor(async () => (await slider.getAttribute('aria-valuenow')) === '3', { message: 'effort high' })

  await sendPrompt(page, 'Denk genauer nach')
  const call = await waitFor(
    async () =>
      (await mockRequests()).find(
        (r) => r.body?.stream && JSON.stringify(r.body?.messages ?? '').includes('Denk genauer nach'),
      ),
    { message: 'chat request with raised effort' },
  )
  assert.equal(call.body.model, 'claude-opus-5-5')
  assert.equal(call.body.output_config?.effort, 'high')
})

/** The effort slider is the one whose label row reads "Effort". */
async function effortSliderIndex(page) {
  const sliders = page.locator('[role="slider"]')
  const count = await sliders.count()
  for (let i = 0; i < count; i++) {
    const label = await sliders.nth(i).evaluate((el) => el.parentElement?.parentElement?.parentElement?.innerText ?? '')
    if (/Effort/.test(label)) return i
  }
  throw new Error('effort slider not found')
}
