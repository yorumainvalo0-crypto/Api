import { app } from 'electron'
import log from 'electron-log/main'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

export interface UpdateStatus {
  state: 'disabled' | 'checking' | 'available' | 'not-available' | 'downloaded' | 'error'
  message: string
}

let status: UpdateStatus = { state: 'disabled', message: 'Updates nur in der installierten App.' }

/** Configures auto-updates from GitHub Releases (packaged builds only). */
export function initUpdater(): void {
  if (!app.isPackaged) return
  autoUpdater.logger = log
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => {
    status = { state: 'checking', message: 'Suche nach Updates …' }
  })
  autoUpdater.on('update-available', (info) => {
    status = { state: 'available', message: `Version ${info.version} wird heruntergeladen …` }
  })
  autoUpdater.on('update-not-available', () => {
    status = { state: 'not-available', message: `Aktuell (Version ${app.getVersion()}).` }
  })
  autoUpdater.on('update-downloaded', (info) => {
    status = {
      state: 'downloaded',
      message: `Version ${info.version} ist bereit und wird beim Beenden installiert.`,
    }
  })
  autoUpdater.on('error', (error) => {
    // Typical causes: no releases yet, private repository, offline.
    status = { state: 'error', message: `Update-Prüfung fehlgeschlagen: ${error.message}` }
  })
  void checkForUpdates()
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) return status
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    status = {
      state: 'error',
      message: `Update-Prüfung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return status
}

export function updateStatus(): UpdateStatus {
  return status
}

export function installUpdateNow(): void {
  if (status.state === 'downloaded') autoUpdater.quitAndInstall()
}
