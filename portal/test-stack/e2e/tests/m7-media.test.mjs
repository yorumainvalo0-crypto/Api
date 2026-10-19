// M7: image, speech and video through OpenRouter (test double), charged to the user's USD budget.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  CREDITS_PER_USD,
  MOCKS_URL,
  PUBLIC_URL,
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

const USERNAME = `media${Date.now() % 100000}`
let browser
let page
let admin

async function scenario(trigger, tool, input, reply) {
  await fetch(`${MOCKS_URL}/__scenarios`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trigger, tool, input, reply }),
  })
}

async function mediaCharges() {
  return withMongo(async (lc) => {
    const user = await lc.collection('users').findOne({ username: USERNAME })
    return lc.collection('transactions').find({ user: user._id, context: 'media' }).toArray()
  })
}

/** Loads a URL in the browser (same DNS mapping as the user) and returns status and type. */
async function fetchInBrowser(url) {
  return page.evaluate(async (u) => {
    const res = await fetch(u)
    return { status: res.status, type: res.headers.get('content-type') }
  }, url)
}

/** The tool result Claude received for the last scripted call. */
async function lastToolResult() {
  const request = (await mockRequests()).filter((r) => r.body?.stream).pop()
  return JSON.stringify(request.body.messages.at(-1).content)
}

before(async () => {
  browser = await launchBrowser()
  admin = await newDevice(browser)
  await adminLogin(admin.page)
  const link = await createUserWithLoginLink(admin.page, USERNAME)
  ;({ page } = await newDevice(browser))
  await loginWithLink(page, link)
  librechatScript('add-balance', '--', `${USERNAME}@${USER_EMAIL_DOMAIN}`, String(5 * CREDITS_PER_USD))
})

after(async () => {
  await fetch(`${MOCKS_URL}/__scenarios`, { method: 'DELETE' })
  await browser?.close()
})

test('Claude creates an image: it appears in the chat and 0.04 $ are charged', async () => {
  await scenario('MALE_BILD', 'bild_erstellen_mcp_portal', { prompt: 'Ein roter Panda als Astronaut' }, 'Hier ist dein Bild.')
  await sendPrompt(page, 'MALE_BILD: einen Panda bitte')
  await page.getByText('Hier ist dein Bild.').first().waitFor({ timeout: 90_000 })

  // The generated image is shown in the conversation
  const image = page.locator('main img[src^="data:image/png"], main img[src*="/images/"]').first()
  await image.waitFor({ timeout: 30_000 })

  const charges = await mediaCharges()
  assert.equal(charges.length, 1)
  assert.equal(charges[0].rawAmount, -0.04 * CREDITS_PER_USD)
  assert.equal(charges[0].mediaKind, 'image')

  // Claude got the image ID and a working download link
  const result = await lastToolResult()
  assert.match(result, /Bild-ID: [0-9a-f-]{36}/)
  const url = result.match(/https:\/\/portal\.test:8443\/portal\/files\/[^\s"\\]+/)[0]
  assert.deepEqual(await fetchInBrowser(url), { status: 200, type: 'image/png' })
})

test('Claude reads text aloud: the MP3 link works and the cost is charged', async () => {
  await scenario('LIES_VOR', 'sprache_erstellen_mcp_portal', { text: 'Guten Morgen!' }, 'Hier ist die Audiodatei.')
  await sendPrompt(page, 'LIES_VOR: Guten Morgen')
  await page.getByText('Hier ist die Audiodatei.').first().waitFor({ timeout: 90_000 })
  const url = (await lastToolResult()).match(/https:\/\/portal\.test:8443\/portal\/files\/[^\s"\\]+/)[0]
  assert.deepEqual(await fetchInBrowser(url), { status: 200, type: 'audio/mpeg' })
  const charges = await mediaCharges()
  assert.equal(charges.filter((c) => c.mediaKind === 'speech').length, 1)
})

test('Claude starts a video; when it is ready the status tool returns the link', async () => {
  await scenario('DREH_VIDEO', 'video_erstellen_mcp_portal', { prompt: 'Wellen am Strand' }, 'Das Video wird erstellt.')
  await sendPrompt(page, 'DREH_VIDEO: Strand')
  await page.getByText('Das Video wird erstellt.').first().waitFor({ timeout: 90_000 })
  const videoId = (await lastToolResult()).match(/Video-ID: ([0-9a-f-]{36})/)[1]

  // The gateway polls OpenRouter every 15 s in the background
  await waitFor(async () => (await mediaCharges()).some((c) => c.mediaKind === 'video'), {
    message: 'video finished and charged',
    timeoutMs: 45_000,
  })
  await scenario('VIDEO_FERTIG', 'video_status_mcp_portal', { video_id: videoId }, 'Status geprüft.')
  await sendPrompt(page, 'VIDEO_FERTIG?')
  await page.getByText('Status geprüft.').first().waitFor({ timeout: 90_000 })
  assert.match(await lastToolResult(), /Das Video ist fertig \(Kosten 0\.50 USD\)/)
})

test('media costs show up in the admin dashboard', async () => {
  await admin.page.goto(`${PUBLIC_URL}/portal/admin/usage?range=today`)
  // All image charges booked today (earlier test runs included)
  const imageTotal = await withMongo(async (lc) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date())
    const rows = await lc.collection('transactions').find({ context: 'media', mediaKind: 'image' }).toArray()
    return rows
      .filter((r) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(r.createdAt) === today)
      .reduce((sum, r) => sum - r.tokenValue, 0) / CREDITS_PER_USD
  })
  const row = admin.page.locator('#by-model tr', { hasText: 'google/gemini-2.5-flash-image' })
  await row.waitFor()
  const shown = Number((await row.locator('.text').innerText()).replace(/\s|\$/g, '').replace(',', '.'))
  assert.ok(Math.abs(shown - imageTotal) < 0.005, `dashboard ${shown} vs bookings ${imageTotal}`)
  await admin.page.locator('#by-model').getByText('google/veo-3.1').waitFor()
})
