// M3: login through the gateway – admin with TOTP, login QR codes, devices, blocking.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  PUBLIC_URL,
  USER_EMAIL_DOMAIN,
  acceptTerms,
  adminLogin,
  createUserWithLoginLink,
  launchBrowser,
  loginWithLink,
  newDevice,
  newLoginLink,
  waitFor,
  withMongo,
} from '../lib.mjs'

const USERNAME = `anna${Date.now() % 100000}`
let browser
let admin
let userPageUrl

before(async () => {
  browser = await launchBrowser()
  admin = await newDevice(browser)
})

after(async () => {
  await browser?.close()
})

test('without a device session LibreChat sends visitors to the gateway, which asks for a QR code', async () => {
  const { page, context } = await newDevice(browser)
  await page.goto(`${PUBLIC_URL}/`)
  await page.getByText('Du bist auf diesem Gerät nicht angemeldet.').waitFor({ timeout: 30_000 })
  assert.match(page.url(), /\/portal\/oidc\/interaction\//)
  await context.close()
})

test('admin logs in with password and TOTP and is an admin in LibreChat too', async () => {
  await adminLogin(admin.page)
  await admin.page.goto(`${PUBLIC_URL}/`)
  await admin.page.waitForURL(/\/c\//, { timeout: 30_000 })
  const role = await waitFor(
    () => withMongo(async (lc) => (await lc.collection('users').findOne({ username: 'chef' }))?.role),
    { message: 'admin user in LibreChat' },
  )
  assert.equal(role, 'ADMIN')
})

test('a login QR logs a new person straight into the chat with the chosen username', async () => {
  const link = await createUserWithLoginLink(admin.page, USERNAME)
  userPageUrl = admin.page.url().split('?')[0]
  assert.ok(link.startsWith(`${PUBLIC_URL}/portal/l/`))

  const phone = await newDevice(browser)
  await loginWithLink(phone.page, link)
  const user = await withMongo((lc) => lc.collection('users').findOne({ username: USERNAME }))
  assert.equal(user.email, `${USERNAME}@${USER_EMAIL_DOMAIN}`)
  assert.equal(user.provider, 'openid')
  assert.equal(user.role, 'USER')

  // The same QR code cannot be used a second time
  const thief = await newDevice(browser)
  await thief.page.goto(link)
  await thief.page.getByText('schon benutzt').waitFor()
  await thief.context.close()
  await phone.context.close()
})

test('a second device sees the same chats', async () => {
  const laptop = await newDevice(browser)
  await admin.page.goto(userPageUrl)
  await loginWithLink(laptop.page, await newLoginLink(admin.page, { note: 'Laptop' }))

  // Create a conversation record directly, as if a chat had happened on the first device
  const conversationId = crypto.randomUUID()
  await withMongo(async (lc) => {
    const user = await lc.collection('users').findOne({ username: USERNAME })
    await lc.collection('conversations').insertOne({
      conversationId,
      user: String(user._id),
      title: 'Halterung für Rohr',
      endpoint: 'anthropic',
      model: 'claude-opus-5-5',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  })
  await laptop.page.reload()
  await acceptTerms(laptop.page)
  await laptop.page.getByText('Halterung für Rohr').first().waitFor({ timeout: 30_000 })

  // The admin sees both devices
  await admin.page.goto(userPageUrl)
  const devices = await admin.page.locator('h2:has-text("Geräte") + .card tbody tr').count()
  assert.equal(devices, 2)
  await laptop.context.close()
})

test('blocking ends the LibreChat session and further logins', async () => {
  const tablet = await newDevice(browser)
  await admin.page.goto(userPageUrl)
  await loginWithLink(tablet.page, await newLoginLink(admin.page, { note: 'Tablet' }))

  await admin.page.goto(userPageUrl)
  await admin.page.click('button:has-text("Sperren")')
  await admin.page.getByText('gesperrt').first().waitFor()

  // A reload has to re-authenticate: the gateway refuses, so the person is logged out
  await tablet.page.reload()
  await tablet.page.getByText('Du bist auf diesem Gerät nicht angemeldet.').waitFor({ timeout: 30_000 })
  await tablet.context.close()
})
