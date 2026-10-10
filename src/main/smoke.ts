import { writeFileSync } from 'node:fs'
import { app, type BrowserWindow } from 'electron'
import log from 'electron-log/main'

/**
 * Headless self-test used by `npm run smoke`: verifies that the renderer loaded,
 * the preload bridge is exposed and typed IPC round-trips work, then exits.
 * When AIW_SMOKE_MOCK_URL is set, it also runs a full chat turn against that
 * Anthropic-compatible mock through the real agent pipeline.
 */
export function runSmokeTest(win: BrowserWindow): void {
  const fail = (reason: string): void => {
    log.error(`[smoke] FAILED: ${reason}`)
    console.error(`[smoke] FAILED: ${reason}`)
    app.exit(1)
  }

  const timeout = setTimeout(() => fail('timeout'), 60_000)
  const mockUrl = process.env['AIW_SMOKE_MOCK_URL'] ?? ''

  win.webContents.once('did-fail-load', (_e, code, desc) => fail(`did-fail-load ${code} ${desc}`))
  win.webContents.once('did-finish-load', () => {
    const script = `(async () => {
      const result = { hasApi: typeof window.api?.invoke === 'function' }
      result.info = await window.api.invoke('app:info')
      result.secrets = await window.api.invoke('secrets:status')
      // Give React a moment to render, then check the root rendered something.
      await new Promise((r) => setTimeout(r, 500))
      result.rendered = (document.getElementById('root')?.childElementCount ?? 0) > 0
      result.title = document.title

      const mockUrl = ${JSON.stringify(mockUrl)}
      if (mockUrl) {
        const current = await window.api.invoke('settings:get')
        await window.api.invoke('settings:update', {
          activeProvider: 'ollama',
          ollamaBaseUrl: mockUrl,
          models: { ...current.models, ollama: 'mock-model' },
        })
        const events = []
        const finished = new Promise((resolve) => {
          const off = window.api.on('agent:event', (e) => {
            events.push(e.type)
            if (e.type === 'text-delta') result.chatText = (result.chatText ?? '') + e.text
            if (e.type === 'error') result.chatError = e.message
            if (e.type === 'done') { off(); resolve() }
          })
        })
        // Attach a pasted 1x1 PNG like a screenshot from the clipboard.
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
        const added = await window.api.invoke('attachments:add', {
          chatId: 'smoke',
          files: [{ source: 'data', name: 'screenshot.png', mimeType: 'image/png', base64: png }],
        })
        result.attachmentErrors = added.errors
        const attachment = added.attachments[0]
        // The image must be viewable through the protected file protocol ...
        const toUrl = (p) => 'aiw-file://local/' + encodeURIComponent(p)
        result.previewStatus = (await fetch(toUrl(attachment.path))).status
        // ... while paths outside the data directory are refused.
        result.outsideStatus = await fetch(toUrl('/etc/hosts')).then((r) => r.status, () => 'blocked')

        result.accepted = (await window.api.invoke('agent:send', {
          chatId: 'smoke', prompt: 'Hallo', attachments: added.attachments,
        })).accepted
        await finished
        result.events = [...new Set(events)]
        const chat = await window.api.invoke('chats:get', { chatId: 'smoke' })
        result.persisted = chat?.messages.map((m) => m.role + ':' + m.attachments.length).join(',')
        result.listed = (await window.api.invoke('chats:list')).some((c) => c.id === 'smoke')
      }
      return result
    })()`
    win.webContents
      .executeJavaScript(script)
      .then((result: Record<string, unknown>) => {
        clearTimeout(timeout)
        console.log(`[smoke] result ${JSON.stringify(result)}`)
        if (result['hasApi'] !== true) return fail('window.api missing')
        if (result['rendered'] !== true) return fail('React root did not render')
        if (mockUrl) {
          if (result['chatError']) return fail(`chat error: ${String(result['chatError'])}`)
          if (typeof result['chatText'] !== 'string' || !result['chatText']) {
            return fail('chat produced no streamed text')
          }
          if (result['previewStatus'] !== 200) return fail('attachment preview not served')
          if (result['outsideStatus'] === 200)
            return fail('file protocol served a file outside data dir')
          if (result['persisted'] !== 'user:1,assistant:0') return fail('chat not persisted')
          if (result['listed'] !== true) return fail('chat missing from list')
        }
        void captureScreenshot(win).then(() => {
          console.log('[smoke] OK')
          app.exit(0)
        })
      })
      .catch((error: unknown) => fail(String(error)))
  })
}

/** Optionally saves a screenshot of the opened smoke chat (AIW_SMOKE_SCREENSHOT=<file.png>). */
async function captureScreenshot(win: BrowserWindow): Promise<void> {
  const target = process.env['AIW_SMOKE_SCREENSHOT']
  if (!target) return
  await win.webContents.executeJavaScript(`(async () => {
    window.dispatchEvent(new Event('focus'))
    await new Promise((r) => setTimeout(r, 300))
    document.querySelector('button[title="Hallo"]')?.click()
    await new Promise((r) => setTimeout(r, 800))
  })()`)
  const image = await win.webContents.capturePage()
  writeFileSync(target, image.toPNG())
  console.log(`[smoke] screenshot ${target}`)
}
