import { join } from 'node:path'
import { app, BrowserWindow, safeStorage, shell } from 'electron'
import log from 'electron-log/main'
import pkg from '../../package.json'
import { SessionManager } from './agent/session-manager'
import { resolveClaudeExecutable } from './agent/executable'
import { registerIpcHandlers, sendEvent } from './ipc/register'
import { SecretStore } from './storage/secret-store'
import { SettingsStore } from './storage/settings-store'
import { runSmokeTest } from './smoke'

const isSmokeTest = process.argv.includes('--smoke-test')

// Allow tests to run against an isolated profile.
if (process.env['AIW_USER_DATA']) app.setPath('userData', process.env['AIW_USER_DATA'])

log.initialize()

let mainWindow: BrowserWindow | undefined

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'AI Workbench',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  win.once('ready-to-show', () => {
    if (!isSmokeTest) win.show()
  })

  // Open external links in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServer) void win.loadURL(devServer)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))

  return win
}

function bootstrap(): void {
  const dataDir = app.getPath('userData')
  const settings = new SettingsStore(join(dataDir, 'settings.json'))
  const secrets = new SecretStore(join(dataDir, 'secrets.json'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(data),
  })

  const sessions = new SessionManager({
    getSettings: () => settings.get(),
    secrets,
    dataDir,
    appVersion: app.getVersion(),
    executablePath: resolveClaudeExecutable(),
    emit: (event) => {
      if (mainWindow) sendEvent(mainWindow.webContents, 'agent:event', event)
    },
  })

  registerIpcHandlers({
    'app:info': () => ({
      version: app.getVersion(),
      platform: `${process.platform}-${process.arch}`,
      agentSdkVersion: pkg.dependencies['@anthropic-ai/claude-agent-sdk'],
    }),
    'settings:get': () => settings.get(),
    'settings:update': (patch) => settings.update(patch),
    'secrets:status': () => secrets.status(),
    'secrets:set': ({ provider, value }) => {
      secrets.set(provider, value)
      return secrets.status()
    },
    'secrets:clear': ({ provider }) => {
      secrets.clear(provider)
      return secrets.status()
    },
    'agent:send': (request) => ({ accepted: sessions.send(request) }),
    'agent:cancel': ({ sessionId }) => ({ ok: sessions.cancel(sessionId) }),
  })

  app.on('before-quit', () => sessions.cancelAll())

  mainWindow = createWindow()
  if (isSmokeTest) runSmokeTest(mainWindow)
}

void app.whenReady().then(() => {
  bootstrap()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
