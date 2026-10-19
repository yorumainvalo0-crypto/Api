// M2: Claude runs code through the portal code runner; generated files become chat downloads.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  CREDITS_PER_USD,
  MOCKS_URL,
  mockRequests,
  USER_EMAIL_DOMAIN,
  adminLogin,
  createUserWithLoginLink,
  launchBrowser,
  librechatScript,
  loginWithLink,
  newDevice,
  sendPrompt,
  waitFor,
  withMongo,
} from '../lib.mjs'

const USERNAME = `m2user${Date.now() % 100000}`
let browser
let page

async function addScenario(scenario) {
  await fetch(`${MOCKS_URL}/__scenarios`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(scenario),
  })
}

before(async () => {
  browser = await launchBrowser()
  const admin = await newDevice(browser)
  await adminLogin(admin.page)
  const link = await createUserWithLoginLink(admin.page, USERNAME)
  await admin.context.close()
  ;({ page } = await newDevice(browser))
  await loginWithLink(page, link)
  // LibreChat creates the account on first login
  librechatScript('add-balance', '--', `${USERNAME}@${USER_EMAIL_DOMAIN}`, String(2 * CREDITS_PER_USD))
})

after(async () => {
  await fetch(`${MOCKS_URL}/__scenarios`, { method: 'DELETE' })
  await browser?.close()
})

test('Claude creates a Word document in the sandbox and it appears as a download in the chat', async () => {
  await addScenario({
    trigger: 'ERSTELLE_WORD',
    tool: 'bash_tool',
    input: {
      command:
        "python3 -c \"from docx import Document; d = Document(); d.add_heading('Testdokument', 0); d.save('/mnt/data/bericht.docx')\"",
    },
    reply: 'Hier ist dein Dokument.',
  })

  await sendPrompt(page, 'ERSTELLE_WORD: bitte ein kurzes Dokument')
  await page.getByText('Hier ist dein Dokument.').first().waitFor({ timeout: 90_000 })

  const file = await waitFor(
    () =>
      withMongo(async (lc) => {
        const user = await lc.collection('users').findOne({ username: USERNAME })
        return lc.collection('files').findOne({ user: user._id, filename: 'bericht.docx' })
      }),
    { message: 'generated file record', timeoutMs: 60_000 },
  )
  assert.ok(file.metadata?.codeEnvRef?.file_id, 'file keeps a reference to the sandbox output')

  // The attachment is shown in the chat and downloads as a real .docx (zip container)
  const attachment = page.getByText('bericht.docx').first()
  await attachment.waitFor({ timeout: 30_000 })
  const downloadButton = page.locator('button[aria-label*="ownload"], a[aria-label*="ownload"]').first()
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), downloadButton.click()])
  assert.equal(download.suggestedFilename(), 'bericht.docx')
  const stream = await download.createReadStream()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  const bytes = Buffer.concat(chunks)
  assert.equal(bytes.subarray(0, 2).toString(), 'PK')
  assert.ok(bytes.length > 1000)
})

test('the document skills are offered to Claude', async () => {
  const chat = (await mockRequests()).filter((r) => r.body?.stream && r.body?.tools?.length).pop()
  const skillTool = chat.body.tools.find((t) => t.name === 'skill')
  assert.ok(skillTool, 'skill tool missing')
  const text = JSON.stringify(skillTool) + JSON.stringify(chat.body.system ?? '')
  for (const name of ['word-documents', 'excel-workbooks', 'powerpoint-decks', 'pdf-documents']) {
    assert.ok(text.includes(name), `skill ${name} not offered`)
  }
})
