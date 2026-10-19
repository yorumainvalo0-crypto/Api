// M7b: technical 3D parts – Claude writes build123d code, the CAD sandbox builds it, the chat
// shows a preview and the gateway serves an interactive 3D viewer and downloads.
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
} from '../lib.mjs'

const USERNAME = `cad${Date.now() % 100000}`
const PIPE_CLAMP = `
from build123d import *

pipe_d = 25          # mm, pipe diameter
wall = 3             # mm
width = 20           # mm, clamp width
screw_d = 4.5        # mm, M4 clearance
flange = 12          # mm

outer = pipe_d / 2 + wall
with BuildPart() as clamp:
    with BuildSketch(Plane.XZ) as profile:
        Circle(outer)
        Rectangle(2 * (outer + flange), wall, align=(Align.CENTER, Align.MIN))
        Circle(pipe_d / 2, mode=Mode.SUBTRACT)
        Rectangle(2 * outer + 1, outer + 1, align=(Align.CENTER, Align.MAX), mode=Mode.SUBTRACT)
    extrude(amount=width / 2, both=True)
    with Locations((outer + flange / 2, 0, wall / 2), (-(outer + flange / 2), 0, wall / 2)):
        Hole(radius=screw_d / 2)
result = clamp.part
`
let browser
let page

async function lastToolResult() {
  const request = (await mockRequests()).filter((r) => r.body?.stream).pop()
  return JSON.stringify(request.body.messages.at(-1).content)
}

before(async () => {
  browser = await launchBrowser()
  const admin = await newDevice(browser)
  await adminLogin(admin.page)
  const link = await createUserWithLoginLink(admin.page, USERNAME)
  await admin.context.close()
  ;({ page } = await newDevice(browser))
  await loginWithLink(page, link)
  librechatScript('add-balance', '--', `${USERNAME}@${USER_EMAIL_DOMAIN}`, String(CREDITS_PER_USD))
})

after(async () => {
  await fetch(`${MOCKS_URL}/__scenarios`, { method: 'DELETE' })
  await browser?.close()
})

let viewerUrl

test('Claude builds a pipe clamp: preview in the chat, dimensions and download links', async () => {
  await fetch(`${MOCKS_URL}/__scenarios`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      trigger: 'BAUE_HALTERUNG',
      tool: 'cad_erstellen_mcp_portal',
      input: { name: 'Rohrschelle 25 mm', code: PIPE_CLAMP },
      reply: 'Die Rohrschelle ist fertig.',
    }),
  })
  await sendPrompt(page, 'BAUE_HALTERUNG für ein 25-mm-Rohr mit M4-Schrauben')
  // The first CAD run after a restart loads the CAD kernel; allow for it
  await page.getByText('Die Rohrschelle ist fertig.').first().waitFor({ timeout: 180_000 })
  // The preview image is in the chat and actually decoded (not just the element)
  await page.waitForFunction(
    () => [...document.querySelectorAll('main img')].some((img) => img.complete && img.naturalWidth >= 500),
    null,
    { timeout: 60_000 },
  )
  // LibreChat fades images in
  await page.waitForTimeout(1500)
  await page.screenshot({ path: '/home/user/Api/docs/screenshots/chat-cad.png' })

  const result = await lastToolResult()
  assert.match(result, /Rohrschelle 25 mm“ – Version 1/)
  // Width over flanges: 2 * (12.5 + 3 + 12) = 55 mm, depth 20 mm, height 15.5 mm
  assert.match(result, /Maße: 55 × 20 × 15,5 mm/)
  assert.match(result, /Wasserdicht \(druckbar\): ja/)
  viewerUrl = result.match(/https:\/\/portal\.test:8443\/portal\/view\/[^\s"\\]+/)[0]
  const stepUrl = result.match(/STEP \(CAD-Programme\): (https:\/\/[^\s"\\]+)/)[1]
  const step = await page.evaluate(async (u) => (await (await fetch(u)).text()).slice(0, 12), stepUrl)
  assert.equal(step, 'ISO-10303-21')
})

test('the 3D viewer renders the model with WebGL and offers the downloads', async () => {
  const { context, page: viewer } = await newDevice(browser)
  await viewer.setViewportSize({ width: 1200, height: 800 })
  await viewer.goto(viewerUrl)
  await viewer.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 60_000 })
  await viewer.waitForTimeout(500)
  // The canvas shows the blue part: count clearly blue pixels
  const bluePixels = await viewer.evaluate(() => {
    const canvas = document.querySelector('#stage canvas')
    const copy = document.createElement('canvas')
    copy.width = canvas.width
    copy.height = canvas.height
    const ctx = copy.getContext('2d')
    ctx.drawImage(canvas, 0, 0)
    const { data } = ctx.getImageData(0, 0, copy.width, copy.height)
    let count = 0
    for (let i = 0; i < data.length; i += 4) if (data[i + 2] > 120 && data[i + 2] > data[i] + 40) count++
    return count
  })
  assert.ok(bluePixels > 5000, `only ${bluePixels} model pixels rendered`)
  assert.match(await viewer.locator('header h1').innerText(), /55 × 20 × 15,5 mm/)
  for (const label of ['STL', '3MF', 'STEP']) await viewer.locator('header a', { hasText: label }).waitFor()

  await viewer.click('[data-view="top"]')
  await viewer.waitForTimeout(300)
  await viewer.screenshot({ path: '/home/user/Api/docs/screenshots/viewer-3d.png' })
  await viewer.click('[data-view="iso"]')
  await viewer.locator('#cut').fill('50')
  await viewer.waitForTimeout(300)
  assert.match(await viewer.locator('#cut-value').innerText(), /7,8 mm/)
  await context.close()
})
