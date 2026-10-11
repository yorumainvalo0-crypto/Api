import { writeFileSync } from 'node:fs'
import { app, type BrowserWindow } from 'electron'
import { createChromiumLoader } from './web/electron-loader'
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
  const projectPath = process.env['AIW_SMOKE_PROJECT'] ?? ''

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

        // Coding agent: open a project, approve the Write tool through the UI channel.
        const projectPath = ${JSON.stringify(projectPath)}
        if (projectPath) {
          const codeChat = await window.api.invoke('chats:create-project', { chatId: 'smoke-code', projectPath })
          result.codeMode = codeChat.mode
          const codeEvents = []
          const codeDone = new Promise((resolve) => {
            const off = window.api.on('agent:event', async (e) => {
              if (e.chatId !== 'smoke-code') return
              codeEvents.push(e.type)
              if (e.type === 'permission-request') {
                await window.api.invoke('agent:permission-respond', { requestId: e.requestId, decision: 'allow' })
              }
              if (e.type === 'error') result.codeError = e.message
              if (e.type === 'done') { off(); resolve() }
            })
          })
          await window.api.invoke('agent:send', { chatId: 'smoke-code', prompt: 'SMOKE-CODE bitte Datei anlegen' })
          await codeDone
          result.codeEvents = [...new Set(codeEvents)]
          const codeChatDetail = await window.api.invoke('chats:get', { chatId: 'smoke-code' })
          result.codeParts = codeChatDetail?.messages.at(-1)?.parts.map((p) => p.type).join(',')
        }

        // Media: the agent saves a 3D model that must show up as output and inline part.
        const mediaDone = new Promise((resolve) => {
          const off = window.api.on('agent:event', (e) => {
            if (e.chatId !== 'smoke-media') return
            if (e.type === 'error') result.mediaError = e.message
            if (e.type === 'done') { off(); resolve() }
          })
        })
        await window.api.invoke('agent:send', { chatId: 'smoke-media', prompt: 'SMOKE-MEDIA Pyramide' })
        await mediaDone
        const outputs = await window.api.invoke('outputs:list', { chatId: 'smoke-media' })
        result.outputs = outputs.map((f) => f.name + ':' + f.kind).join(',')
        const mediaChat = await window.api.invoke('chats:get', { chatId: 'smoke-media' })
        result.mediaParts = mediaChat?.messages.at(-1)?.parts.map((p) => p.type).join(',')
        if (outputs[0]) result.outputStatus = (await fetch(toUrl(outputs[0].path))).status
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
          if (result['mediaError']) return fail(`media error: ${String(result['mediaError'])}`)
          if (result['outputs'] !== 'pyramide.obj:model3d') return fail('3D output not listed')
          if (result['mediaParts'] !== 'tool,file,text') return fail('media parts wrong')
          if (result['outputStatus'] !== 200) return fail('output file not served')
          if (projectPath) {
            if (result['codeError']) return fail(`code error: ${String(result['codeError'])}`)
            if (result['codeParts'] !== 'text,tool,text') return fail('code reply parts wrong')
            const codeEvents = result['codeEvents'] as string[] | undefined
            if (!codeEvents?.includes('permission-request')) return fail('no permission request')
          }
        }
        void checkChromiumLoader(mockUrl)
          .then((ok) => {
            if (!ok) throw new Error('hidden Chromium loader did not render JavaScript content')
            return checkPopoverDismiss(win)
          })
          .then(() => checkTerminal(win, projectPath))
          .then(() => {
            return captureScreenshot(win)
          })
          .then(() => {
            console.log('[smoke] OK')
            app.exit(0)
          })
          .catch((error: unknown) => fail(String(error)))
      })
      .catch((error: unknown) => fail(String(error)))
  })
}

/** Opens the model picker and verifies a real mouse click outside closes it again. */
async function checkPopoverDismiss(win: BrowserWindow): Promise<void> {
  const searchOpen = `Boolean(document.querySelector('input[placeholder^="Suchen oder Modell-ID"]'))`
  const opened = (await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('main header button[aria-haspopup="listbox"]')?.click()
    await new Promise((r) => setTimeout(r, 200))
    return ${searchOpen}
  })()`)) as boolean
  if (!opened) throw new Error('model picker did not open')
  const [width = 800, height = 600] = win.getContentSize()
  const point = { x: Math.round(width * 0.75), y: Math.round(height * 0.8) }
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  const stillOpen = (await win.webContents.executeJavaScript(`(async () => {
    await new Promise((r) => setTimeout(r, 200))
    return ${searchOpen}
  })()`)) as boolean
  if (stillOpen) throw new Error('model picker did not close on an outside click')
  console.log('[smoke] popover closes on outside click')

  // Native select popups follow color-scheme; it must match the app theme, not the OS.
  const theme = (await win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('main header select')
    const option = select?.querySelector('option')
    return {
      dark: document.documentElement.classList.contains('dark'),
      scheme: getComputedStyle(document.documentElement).colorScheme,
      optionBg: option ? getComputedStyle(option).backgroundColor : null,
      optionColor: option ? getComputedStyle(option).color : null,
    }
  })()`)) as { dark: boolean; scheme: string; optionBg: string | null; optionColor: string | null }
  if (theme.scheme !== (theme.dark ? 'dark' : 'light')) {
    throw new Error(`color-scheme ${theme.scheme} does not match the app theme`)
  }
  if (theme.optionBg !== null && theme.optionBg === theme.optionColor) {
    throw new Error('select options are unreadable')
  }
  console.log(`[smoke] theme ${JSON.stringify(theme)}`)
}

/**
 * Starts a real shell in a PTY through IPC (node-pty must load from app.asar.unpacked in the
 * packaged app) and runs the bundled Claude Code through the generated `claude` wrapper on PATH.
 */
async function checkTerminal(win: BrowserWindow, cwd: string): Promise<void> {
  const result = (await win.webContents.executeJavaScript(`(async () => {
    const sessionId = crypto.randomUUID()
    let output = ''
    const off = window.api.on('terminal:data', (e) => { if (e.sessionId === sessionId) output += e.data })
    const waitFor = async (text, ms) => {
      const start = Date.now()
      while (!output.includes(text)) {
        if (Date.now() - start > ms) throw new Error('terminal: no "' + text + '" in ' + JSON.stringify(output.slice(-600)))
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    try {
      const cwd = ${JSON.stringify(cwd)}
      const created = await window.api.invoke('terminal:create', {
        sessionId, cols: 120, rows: 30, ...(cwd ? { cwd } : {}),
      })
      const powershell = /pwsh|powershell/i.test(created.shell)
      const write = (data) => window.api.invoke('terminal:write', { sessionId, data })
      // The marker is assembled by the shell, so the echoed input does not contain it.
      await write((powershell ? "Write-Output ('AIW-PTY' + '-OK')" : 'echo AIW-PTY""-OK') + '\\r')
      await waitFor('AIW-PTY-OK', 30000)
      await write('claude --version\\r')
      await waitFor('(Claude Code)', 60000)
      return { shell: created.shell, ok: true }
    } finally {
      off()
      // Wait until the shell has really exited; quitting earlier can crash ConPTY on Windows.
      const exited = new Promise((resolve) => {
        const stop = window.api.on('terminal:exit', (e) => {
          if (e.sessionId === sessionId) { stop(); resolve(true) }
        })
        setTimeout(() => resolve(false), 8000)
      })
      await window.api.invoke('terminal:kill', { sessionId })
      await exited
    }
  })()`)) as { shell: string; ok: boolean }
  console.log(`[smoke] terminal ${JSON.stringify(result)}`)
}

/** Optionally saves a screenshot of the opened smoke chat (AIW_SMOKE_SCREENSHOT=<file.png>). */
async function captureScreenshot(win: BrowserWindow): Promise<void> {
  const target = process.env['AIW_SMOKE_SCREENSHOT']
  if (!target) return
  await win.webContents.executeJavaScript(`(async () => {
    window.dispatchEvent(new Event('focus'))
    await new Promise((r) => setTimeout(r, 300))
    const target = ${JSON.stringify(process.env['AIW_SMOKE_SCREENSHOT_CHAT'] ?? 'Hallo')}
    document.querySelector('button[title="' + target + '"]')?.click()
    await new Promise((r) => setTimeout(r, 800))
  })()`)
  const image = await win.webContents.capturePage()
  writeFileSync(target, image.toPNG())
  console.log(`[smoke] screenshot ${target}`)
}

/** Verifies the web_fetch browser path: a JS-rendered page must come back with its content. */
async function checkChromiumLoader(mockUrl: string): Promise<boolean> {
  if (!mockUrl) return true
  const page = await createChromiumLoader(15_000, 300)(`${mockUrl}/js-page`)
  console.log(`[smoke] chromium loader status ${page.status}`)
  return page.body.includes('Von JavaScript gerendert')
}
