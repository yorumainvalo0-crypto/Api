// M4: groups and invite QR codes – limited seats, time window, self-chosen username.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { PUBLIC_URL, acceptTerms, adminLogin, launchBrowser, newDevice, withMongo } from '../lib.mjs'

const GROUP = `Workshop ${Date.now() % 100000}`
const suffix = Date.now() % 10000
let browser
let admin
let inviteLink

/** A phone-sized browser profile. */
async function newPhone() {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  })
  return { context, page: await context.newPage() }
}

before(async () => {
  browser = await launchBrowser()
  admin = await newDevice(browser)
  await adminLogin(admin.page)
})

after(async () => {
  await browser?.close()
})

test('admin creates a group and an invite QR for two people', async () => {
  const page = admin.page
  await page.goto(`${PUBLIC_URL}/portal/admin/groups`)
  await page.fill('#name', GROUP)
  await page.fill('#defaultStartBudgetUsd', '2')
  await page.fill('#defaultMonthlyBudgetUsd', '4')
  await page.click('form[action="/portal/admin/groups"] button[type="submit"]')
  await page.waitForURL(/\/portal\/admin\/groups\/[0-9a-f-]+$/)

  await page.fill('#maxUses', '2')
  await page.fill('#note', 'Test-Workshop')
  await page.click('form[action$="/invites"] button[type="submit"]')
  await page.locator('#invite-qr svg').waitFor()
  inviteLink = (await page.locator('#invite-link').innerText()).trim()
  assert.match(inviteLink, /\/portal\/join\//)
  assert.match(await page.locator('#invite-qr').innerText(), /2 von 2 Plätzen frei/)
})

test('two people join on their phones with their own usernames and land in the chat', async () => {
  for (const name of [`Mia${suffix}`, `noah${suffix}`]) {
    const phone = await newPhone()
    await phone.page.goto(inviteLink)
    await phone.page.getByText(GROUP).waitFor()
    // The join form fits the phone screen without horizontal scrolling
    const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    assert.equal(overflow, false)
    await phone.page.fill('#username', name)
    await phone.page.click('button[type="submit"]')
    await phone.page.waitForURL(/\/c\//, { timeout: 30_000 })
    await acceptTerms(phone.page)
    const user = await withMongo((lc) => lc.collection('users').findOne({ username: name.toLowerCase() }))
    assert.ok(user, `LibreChat account for ${name}`)
    await phone.context.close()
  }
})

test('a third person is turned away because both seats are taken', async () => {
  const phone = await newPhone()
  await phone.page.goto(inviteLink)
  await phone.page.getByText('Alle Plätze dieser Einladung sind vergeben.').waitFor()
  await phone.context.close()

  await admin.page.reload()
  const row = admin.page.locator('tr', { hasText: 'Test-Workshop' })
  assert.match(await row.innerText(), /2 \/ 2/)
  assert.match(await row.innerText(), /alle Plätze vergeben/)
  const members = await admin.page.locator('h2:has-text("Mitglieder") + .card tbody tr').count()
  assert.equal(members, 2)
})

test('a taken username is rejected without using up a seat', async () => {
  await admin.page.fill('#maxUses', '1')
  await admin.page.fill('#note', 'Einzelplatz')
  await admin.page.click('form[action$="/invites"] button[type="submit"]')
  await admin.page.locator('#invite-qr svg').waitFor()
  const link = (await admin.page.locator('#invite-link').innerText()).trim()

  const phone = await newPhone()
  await phone.page.goto(link)
  await phone.page.fill('#username', `mia${suffix}`)
  await phone.page.click('button[type="submit"]')
  await phone.page.getByText('schon vergeben').waitFor()
  await phone.page.fill('#username', `olivia${suffix}`)
  await phone.page.click('button[type="submit"]')
  await phone.page.waitForURL(/\/c\//, { timeout: 30_000 })
  await phone.context.close()
})
