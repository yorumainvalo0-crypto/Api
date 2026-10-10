import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '@shared/schemas/updates'

const updater = Object.assign(new EventEmitter(), {
  checkForUpdates: vi.fn(async () => undefined),
  quitAndInstall: vi.fn(),
  logger: null as unknown,
  autoDownload: false,
  autoInstallOnAppQuit: false,
})

vi.mock('electron', () => ({ app: { getVersion: () => '0.1.0', isPackaged: true } }))
vi.mock('electron-log/main', () => ({ default: {} }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: updater } }))

const { checkForUpdates, describeUpdateError, initUpdater, installUpdateNow, updateStatus } =
  await import('../src/main/updater')

describe('update error messages', () => {
  it('treats a repository without releases as "up to date"', () => {
    expect(describeUpdateError(new Error('No published versions on GitHub'))).toMatchObject({
      state: 'not-available',
      message: 'Aktuell (Version 0.1.0) – auf GitHub ist noch keine neuere Version veröffentlicht.',
    })
  })

  it('explains offline, corrupt and other errors briefly', () => {
    expect(describeUpdateError(new Error('getaddrinfo ENOTFOUND github.com')).message).toBe(
      'Update fehlgeschlagen: keine oder unterbrochene Internetverbindung.',
    )
    expect(
      describeUpdateError(new Error('sha512 checksum mismatch, expected x')).message,
    ).toContain('beschädigt')
    expect(describeUpdateError(new Error('Bad signature\nstack…')).message).toBe(
      'Update fehlgeschlagen: Bad signature',
    )
  })
})

describe('update status flow', () => {
  it('pushes every state change, including download progress', async () => {
    const seen: UpdateStatus[] = []
    initUpdater((s) => seen.push(s))
    expect(updater.autoDownload).toBe(true)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)

    updater.emit('checking-for-update')
    updater.emit('update-available', { version: '0.2.0' })
    updater.emit('download-progress', {
      percent: 42.7,
      transferred: 90 * 1024 * 1024,
      total: 200 * 1024 * 1024,
      bytesPerSecond: 5 * 1024 * 1024,
    })
    expect(seen.map((s) => s.state)).toEqual(['checking', 'available', 'downloading'])
    expect(seen.at(-1)).toMatchObject({ version: '0.2.0', percent: 42.7 })
    expect(seen.at(-1)?.message).toBe('Lade Version 0.2.0 … 42 % (90 von 200 MB, 5 MB/s)')

    // Checking again while downloading must not restart the download.
    await checkForUpdates()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(installUpdateNow()).toBe(false)

    updater.emit('update-downloaded', { version: '0.2.0' })
    expect(updateStatus()).toMatchObject({ state: 'downloaded', version: '0.2.0', percent: 100 })
    expect(installUpdateNow()).toBe(true)
    await new Promise((r) => setImmediate(r))
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('reports download errors to the UI', () => {
    const seen: UpdateStatus[] = []
    initUpdater((s) => seen.push(s))
    updater.emit('error', new Error('read ECONNRESET'))
    expect(seen.at(-1)).toMatchObject({ state: 'error' })
  })
})
