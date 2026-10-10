import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '0.1.0', isPackaged: false } }))
vi.mock('electron-log/main', () => ({ default: {} }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }))

const { describeUpdateError } = await import('../src/main/updater')

describe('update error messages', () => {
  it('treats a repository without releases as "up to date"', () => {
    expect(describeUpdateError(new Error('No published versions on GitHub'))).toEqual({
      state: 'not-available',
      message: 'Aktuell (Version 0.1.0) – auf GitHub ist noch keine neuere Version veröffentlicht.',
    })
  })

  it('explains offline errors and keeps other errors short', () => {
    expect(describeUpdateError(new Error('getaddrinfo ENOTFOUND github.com')).message).toBe(
      'Update-Prüfung fehlgeschlagen: keine Internetverbindung.',
    )
    expect(describeUpdateError(new Error('Bad signature\nstack…')).message).toBe(
      'Update-Prüfung fehlgeschlagen: Bad signature',
    )
  })
})
