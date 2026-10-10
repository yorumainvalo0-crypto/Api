import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { copyFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron'
import log from 'electron-log/main'
import pkg from '../../package.json'
import { chatAttachmentsDir, chatWorkspace, SessionManager } from './agent/session-manager'
import { resolveClaudeExecutable } from './agent/executable'
import { registerIpcHandlers, sendEvent } from './ipc/register'
import { listModels, testConnection } from './providers/model-catalog'
import { createProjectHandlers } from './project/handlers'
import { AddonStore } from './addons/addon-store'
import { createAddonHandlers } from './addons/handlers'
import { isAllowedPath, isExecutable, listOutputs, outputsDir } from './media/outputs'
import { ChatRepository } from './storage/chat-repository'
import { chatToMarkdown, exportFileName } from './storage/chat-export'
import { openDatabase } from './storage/database'
import { SecretStore } from './storage/secret-store'
import { SettingsStore } from './storage/settings-store'
import { storeAttachment } from './workspace/attachments'
import { handleFileProtocol, registerFileProtocolScheme } from './workspace/file-protocol'
import { runSmokeTest } from './smoke'
import { checkForUpdates, initUpdater, installUpdateNow } from './updater'
import { createChromiumLoader, createSmartLoader } from './web/electron-loader'
import { createWebMcpServer } from './web/mcp-server'
import { createFetchLoader, WebClient } from './web/web-client'

const isSmokeTest = process.argv.includes('--smoke-test')

// Allow tests to run against an isolated profile.
if (process.env['AIW_USER_DATA']) app.setPath('userData', process.env['AIW_USER_DATA'])

log.initialize()
registerFileProtocolScheme()
// Allow WebGL (3D viewer) to fall back to software rendering on machines without a usable GPU
// driver (e.g. VMs). Only local app content uses WebGL; web pages load with WebGL disabled.
app.commandLine.appendSwitch('enable-unsafe-swiftshader')

// Never crash silently: log unexpected errors from the main process.
process.on('uncaughtException', (error) => log.error('uncaughtException', error))
process.on('unhandledRejection', (reason) => log.error('unhandledRejection', reason))

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

  win.once('ready-to-show', () => win.show())

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
  const cipher = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain: string) => safeStorage.encryptString(plain),
    decrypt: (data: Buffer) => safeStorage.decryptString(data),
  }
  const secrets = new SecretStore(join(dataDir, 'secrets.json'), cipher)
  // Skills live in the agent's isolated config dir, where the runtime discovers them.
  const addons = new AddonStore(
    {
      skillsDir: join(dataDir, 'agent-config', 'skills'),
      pluginsDir: join(dataDir, 'addons', 'plugins'),
      stateFile: join(dataDir, 'addons', 'addons.json'),
    },
    cipher,
  )

  const chats = new ChatRepository(openDatabase(join(dataDir, 'workbench.db')))
  // Files may be served/saved from the data dir and from project folders the user opened.
  const allowedRoots = () => [
    dataDir,
    ...chats.list().flatMap((c) => (c.projectPath ? [c.projectPath] : [])),
  ]
  const assertAllowed = (path: string) => {
    if (!isAllowedPath(path, allowedRoots()))
      throw new Error('Zugriff auf diese Datei ist nicht erlaubt.')
  }
  handleFileProtocol(allowedRoots)

  const catalogArgs = (provider: Parameters<typeof listModels>[0]['provider']) => ({
    provider,
    secret: secrets.get(provider),
    ollamaBaseUrl: settings.get().ollamaBaseUrl,
  })

  const fetchLoader = createFetchLoader()
  const web = new WebClient({
    searchLoader: fetchLoader,
    pageLoader: createSmartLoader(fetchLoader, createChromiumLoader()),
  })

  const sessions = new SessionManager({
    createWebServer: () => createWebMcpServer(web),
    getAddons: () => addons.agentConfig(),
    getSettings: () => settings.get(),
    secrets,
    chats,
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
      dataDir,
    }),
    'settings:get': () => settings.get(),
    'updates:check': () => checkForUpdates(),
    'updates:install': () => {
      installUpdateNow()
      return { ok: true }
    },
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
    'models:list': ({ provider }) => listModels(catalogArgs(provider)),
    'models:test': ({ provider }) => testConnection(catalogArgs(provider)),
    'chats:list': () => chats.list(),
    'chats:get': ({ chatId }) => chats.get(chatId) ?? null,
    'chats:rename': ({ chatId, title }) => {
      chats.rename(chatId, title)
      return { ok: true }
    },
    'chats:delete': ({ chatId }) => {
      sessions.cancel(chatId)
      chats.delete(chatId)
      rmSync(chatWorkspace(dataDir, chatId), { recursive: true, force: true })
      return { ok: true }
    },
    'attachments:add': ({ chatId, files }) => {
      const dir = chatAttachmentsDir(dataDir, chatId)
      const attachments = []
      const errors: string[] = []
      for (const file of files) {
        try {
          attachments.push(storeAttachment(file, dir))
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error))
        }
      }
      return { attachments, errors }
    },
    'chats:export': async ({ chatId, format }) => {
      const chat = chats.get(chatId)
      if (!chat || !mainWindow) return { savedTo: null }
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: exportFileName(chat.title, format),
        filters: [
          format === 'md'
            ? { name: 'Markdown', extensions: ['md'] }
            : { name: 'JSON', extensions: ['json'] },
        ],
      })
      if (result.canceled || !result.filePath) return { savedTo: null }
      writeFileSync(
        result.filePath,
        format === 'md' ? chatToMarkdown(chat) : JSON.stringify(chat, null, 2),
        'utf8',
      )
      return { savedTo: result.filePath }
    },
    'chats:backup': async () => {
      if (!mainWindow) return { savedTo: null }
      const stamp = new Date().toISOString().slice(0, 10)
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: `ai-workbench-backup-${stamp}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePath) return { savedTo: null }
      const all = chats.list().flatMap((c) => {
        const detail = chats.get(c.id)
        return detail ? [detail] : []
      })
      writeFileSync(
        result.filePath,
        JSON.stringify({ version: 1, exportedAt: Date.now(), chats: all }, null, 2),
        'utf8',
      )
      return { savedTo: result.filePath }
    },
    'chats:create-project': ({ chatId, projectPath }) =>
      sessions.createProjectChat({ ...(chatId ? { chatId } : {}), projectPath }),
    'chats:set-permission-mode': async ({ chatId, mode }) => {
      await sessions.setPermissionMode(chatId, mode)
      return { ok: true }
    },
    'dialog:open-folder': async () => {
      if (!mainWindow) return null
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Projektordner öffnen',
        properties: ['openDirectory', 'createDirectory'],
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    'dialog:open-files': async () => {
      if (!mainWindow) return []
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
      })
      return result.canceled ? [] : result.filePaths
    },
    'outputs:list': ({ chatId }) => {
      const chat = chats.summary(chatId)
      return chat ? listOutputs(outputsDir(dataDir, chat)) : []
    },
    'files:save-as': async ({ path }) => {
      assertAllowed(path)
      if (!mainWindow) return { savedTo: null }
      const result = await dialog.showSaveDialog(mainWindow, { defaultPath: basename(path) })
      if (result.canceled || !result.filePath) return { savedTo: null }
      copyFileSync(path, result.filePath)
      return { savedTo: result.filePath }
    },
    'files:show-in-folder': ({ path }) => {
      assertAllowed(path)
      shell.showItemInFolder(path)
      return { ok: true }
    },
    'files:open-external': async ({ path }) => {
      assertAllowed(path)
      // Never launch programs or scripts the agent may have written.
      if (isExecutable(path))
        throw new Error('Ausführbare Dateien werden aus Sicherheitsgründen nicht geöffnet.')
      return { ok: (await shell.openPath(path)) === '' }
    },
    'agent:send': (request) => ({ accepted: sessions.send(request) }),
    'agent:cancel': ({ chatId }) => ({ ok: sessions.cancel(chatId) }),
    'agent:permission-respond': ({ requestId, decision, message }) => ({
      ok: sessions.respondToPermission(requestId, decision, message),
    }),
    ...createProjectHandlers({ getTarget: () => mainWindow?.webContents }),
    ...createAddonHandlers({ store: addons, getWindow: () => mainWindow }),
  })

  app.on('before-quit', () => sessions.cancelAll())

  mainWindow = createWindow()
  if (isSmokeTest) runSmokeTest(mainWindow)
  else initUpdater()
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
