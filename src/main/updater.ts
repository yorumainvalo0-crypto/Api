import { app } from 'electron'
import log from 'electron-log/main'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/schemas/updates'

const { autoUpdater } = electronUpdater

export type { UpdateStatus }

let status: UpdateStatus = {
  state: 'disabled',
  message: 'Updates nur in der installierten App.',
  version: null,
  percent: null,
}
let listener: ((status: UpdateStatus) => void) | undefined

function setStatus(next: UpdateStatus): void {
  status = next
  listener?.(next)
}

const megabytes = (bytes: number) =>
  (bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })

/**
 * Configures auto-updates from GitHub Releases (packaged builds only). `onChange` receives every
 * state change, including download progress, so the UI never shows a stale state.
 */
export function initUpdater(onChange: (status: UpdateStatus) => void): void {
  listener = onChange
  if (!app.isPackaged) return
  autoUpdater.logger = log
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => {
    setStatus({ state: 'checking', message: 'Suche nach Updates …', version: null, percent: null })
  })
  autoUpdater.on('update-available', (info) => {
    setStatus({
      state: 'available',
      message: `Version ${info.version} gefunden – Download startet …`,
      version: info.version,
      percent: 0,
    })
  })
  autoUpdater.on('download-progress', (p) => {
    setStatus({
      state: 'downloading',
      message: `Lade Version ${status.version ?? ''} … ${Math.floor(p.percent)} % (${megabytes(p.transferred)} von ${megabytes(p.total)} MB, ${megabytes(p.bytesPerSecond)} MB/s)`,
      version: status.version,
      percent: p.percent,
    })
  })
  autoUpdater.on('update-not-available', () => {
    setStatus({
      state: 'not-available',
      message: `Aktuell (Version ${app.getVersion()}).`,
      version: null,
      percent: null,
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    setStatus({
      state: 'downloaded',
      message: `Version ${info.version} ist bereit. Installiert wird beim Beenden – oder jetzt mit „Neu starten“.`,
      version: info.version,
      percent: 100,
    })
  })
  autoUpdater.on('error', (error) => {
    setStatus(describeUpdateError(error))
  })
  void checkForUpdates()
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) return status
  // A download in progress or a finished one must not be restarted by another check.
  if (status.state === 'downloading' || status.state === 'downloaded') return status
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    setStatus(describeUpdateError(error))
  }
  return status
}

/** Turns updater errors into a German status; "no release yet" is not an error for the user. */
export function describeUpdateError(error: unknown): UpdateStatus {
  const message = error instanceof Error ? error.message : String(error)
  const base = { version: null, percent: null }
  if (/no published versions|Unable to find latest version|HttpError: 404/i.test(message)) {
    return {
      ...base,
      state: 'not-available',
      message: `Aktuell (Version ${app.getVersion()}) – auf GitHub ist noch keine neuere Version veröffentlicht.`,
    }
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|net::ERR_/i.test(message)) {
    return {
      ...base,
      state: 'error',
      message: 'Update fehlgeschlagen: keine oder unterbrochene Internetverbindung.',
    }
  }
  if (/sha512 checksum mismatch/i.test(message)) {
    return {
      ...base,
      state: 'error',
      message:
        'Update fehlgeschlagen: Die heruntergeladene Datei ist beschädigt. Bitte erneut suchen.',
    }
  }
  return { ...base, state: 'error', message: `Update fehlgeschlagen: ${message.split('\n')[0]}` }
}

export function updateStatus(): UpdateStatus {
  return status
}

export function installUpdateNow(): boolean {
  if (status.state !== 'downloaded') return false
  // Silent install (no wizard), then start the new version.
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
  return true
}
