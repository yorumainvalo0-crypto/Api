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
        result.accepted = (await window.api.invoke('agent:send', { sessionId: 'smoke', prompt: 'Hallo' })).accepted
        await finished
        result.events = [...new Set(events)]
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
        }
        console.log('[smoke] OK')
        app.exit(0)
      })
      .catch((error: unknown) => fail(String(error)))
  })
}
