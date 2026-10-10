import { BrowserWindow, session } from 'electron'
import type { LoadedPage, PageLoader } from './web-client'

const PARTITION = 'aiw-web'
let configured = false

function webSession() {
  const ses = session.fromPartition(PARTITION)
  if (!configured) {
    configured = true
    // Never download files or grant permissions to visited pages.
    ses.on('will-download', (event) => event.preventDefault())
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  }
  return ses
}

/** Renders a page in a hidden, sandboxed Chromium window and returns the resulting HTML. */
export function createChromiumLoader(timeoutMs = 25_000, settleMs = 1200): PageLoader {
  return async (url, signal) => {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        session: webSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true,
        images: false,
        webgl: false,
        backgroundThrottling: false,
      },
    })
    win.webContents.setAudioMuted(true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    let status = 200
    win.webContents.on('did-navigate', (_e, _url, httpResponseCode) => {
      status = httpResponseCode
    })

    const abort = () => win.destroy()
    signal?.addEventListener('abort', abort)
    try {
      await Promise.race([
        win.loadURL(url),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Zeitüberschreitung beim Laden')), timeoutMs),
        ),
      ])
      // Give client-side rendering a moment to finish.
      await new Promise((resolve) => setTimeout(resolve, settleMs))
      const body = (await win.webContents.executeJavaScript(
        'document.documentElement.outerHTML',
      )) as string
      const page: LoadedPage = {
        status,
        finalUrl: win.webContents.getURL() || url,
        body,
        contentType: 'text/html',
      }
      return page
    } finally {
      signal?.removeEventListener('abort', abort)
      if (!win.isDestroyed()) win.destroy()
    }
  }
}

/**
 * Fast path first (plain HTTP); falls back to Chromium for pages whose content is rendered
 * by JavaScript or that block simple HTTP clients.
 */
export function createSmartLoader(fetchLoader: PageLoader, chromium: PageLoader): PageLoader {
  return async (url, signal) => {
    try {
      const page = await fetchLoader(url, signal)
      const isHtml = /html/i.test(page.contentType)
      const visibleText = isHtml
        ? page.body
            .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, '')
            .trim()
        : page.body
      if (page.status < 400 && (!isHtml || visibleText.length > 800)) return page
    } catch (error) {
      if (signal?.aborted) throw error
    }
    return chromium(url, signal)
  }
}
