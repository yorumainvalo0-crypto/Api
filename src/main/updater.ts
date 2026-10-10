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
    status = describeUpdateError(error)
  })
  void checkForUpdates()
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) return status
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    status = describeUpdateError(error)
  }
  return status
}

/** Turns updater errors into a German status; "no release yet" is not an error for the user. */
export function describeUpdateError(error: unknown): UpdateStatus {
  const message = error instanceof Error ? error.message : String(error)
  if (/no published versions|Unable to find latest version|HttpError: 404/i.test(message)) {
    return {
      state: 'not-available',
      message: `Aktuell (Version ${app.getVersion()}) – auf GitHub ist noch keine neuere Version veröffentlicht.`,
    }
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(message)) {
    return { state: 'error', message: 'Update-Prüfung fehlgeschlagen: keine Internetverbindung.' }
  }
  return { state: 'error', message: `Update-Prüfung fehlgeschlagen: ${message.split('\n')[0]}` }
}

export function updateStatus(): UpdateStatus {
  return status
}

export function installUpdateNow(): void {
  if (status.state === 'downloaded') autoUpdater.quitAndInstall()
}
