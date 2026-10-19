// M6: usage dashboard – totals match LibreChat's bookings, chart and tables render, CSV export.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  CREDITS_PER_USD,
  PUBLIC_URL,
  adminLogin,
  createUserWithLoginLink,
  launchBrowser,
  librechatScript,
  loginWithLink,
  newDevice,
  sendPrompt,
  USER_EMAIL_DOMAIN,
  withMongo,
} from '../lib.mjs'

const USERNAME = `dash${Date.now() % 100000}`
let browser
let admin

before(async () => {
  browser = await launchBrowser()
  admin = await newDevice(browser)
  await adminLogin(admin.page)
  // Make sure there is at least one chat today
  const link = await createUserWithLoginLink(admin.page, USERNAME)
  const { page } = await newDevice(browser)
  await loginWithLink(page, link)
  librechatScript('add-balance', '--', `${USERNAME}@${USER_EMAIL_DOMAIN}`, String(CREDITS_PER_USD))
  await sendPrompt(page, 'Für das Dashboard')
  await page.getByText('Hallo vom Test-Claude.').first().waitFor({ timeout: 60_000 })
})

after(async () => {
  await browser?.close()
})

test('the total for today equals the spending booked in LibreChat today', async () => {
  const expected = await withMongo(async (lc) => {
    const rows = await lc
      .collection('transactions')
      .find({ tokenType: { $in: ['prompt', 'completion'] }, tokenValue: { $lt: 0 } })
      .toArray()
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date())
    return rows
      .filter((r) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(r.createdAt) === today)
      .reduce((sum, r) => sum - r.tokenValue, 0) / CREDITS_PER_USD
  })
  assert.ok(expected > 0)

  await admin.page.goto(`${PUBLIC_URL}/portal/admin/usage?range=today`)
  const shown = (await admin.page.locator('#total-cost').innerText()).replace(/\s|\$/g, '').replace(',', '.')
  assert.ok(Math.abs(Number(shown) - expected) < 0.00005, `dashboard ${shown} vs bookings ${expected}`)
  // 24 hourly bars, our user appears in the table
  assert.equal(await admin.page.locator('.viz svg .hit').count(), 24)
  await admin.page.locator('#by-user').getByText(USERNAME).waitFor()
  await admin.page.locator('#by-model').getByText('claude-opus-5-5').waitFor()
})

test('hovering a bar shows a tooltip with cost and tokens', async () => {
  await admin.page.goto(`${PUBLIC_URL}/portal/admin/usage?range=7d`)
  const bars = admin.page.locator('.viz svg .hit')
  assert.equal(await bars.count(), 7)
  await bars.last().hover()
  const tip = admin.page.locator('#tooltip')
  await tip.waitFor({ state: 'visible' })
  assert.match(await tip.innerText(), /\$ · .* Tokens rein · .* Tokens raus/)
})

test('CSV export downloads one row per day, person and model', async () => {
  await admin.page.goto(`${PUBLIC_URL}/portal/admin/usage?range=today`)
  const [download] = await Promise.all([admin.page.waitForEvent('download'), admin.page.click('text=CSV herunterladen')])
  assert.equal(download.suggestedFilename(), 'verbrauch-today.csv')
  const chunks = []
  for await (const chunk of await download.createReadStream()) chunks.push(chunk)
  const csv = Buffer.concat(chunks).toString('utf8')
  assert.match(csv, /^﻿Datum;Benutzer;Gruppe;Modell;Kosten USD;Tokens Eingabe;Tokens Ausgabe;Anfragen/)
  assert.match(csv, new RegExp(`;${USERNAME};;claude-opus-5-5;0,014000;1000;500;1`))
})
