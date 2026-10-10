import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsPatchSchema } from '@shared/schemas/settings'
import { SettingsStore } from '../src/main/storage/settings-store'
import { SecretStore, type Cipher } from '../src/main/storage/secret-store'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiw-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Reversible fake cipher so tests can verify nothing is stored in plain text. */
const fakeCipher: Cipher = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from(plain.split('').reverse().join(''), 'utf8'),
  decrypt: (data) => data.toString('utf8').split('').reverse().join(''),
}

describe('SettingsStore', () => {
  it('returns defaults when no file exists', () => {
    expect(new SettingsStore(join(dir, 's.json')).get()).toEqual(DEFAULT_SETTINGS)
  })

  it('persists and merges partial updates', () => {
    const file = join(dir, 's.json')
    new SettingsStore(file).update({
      activeProvider: 'ollama',
      models: { ...DEFAULT_SETTINGS.models, ollama: 'm' },
    })
    const reloaded = new SettingsStore(file).get()
    expect(reloaded.activeProvider).toBe('ollama')
    expect(reloaded.models.ollama).toBe('m')
    expect(reloaded.models.anthropic).toBe('')
  })

  it('keeps untouched settings when a patch comes through the IPC schema', () => {
    const store = new SettingsStore(join(dir, 's.json'))
    store.update({
      activeProvider: 'openrouter',
      models: { ...DEFAULT_SETTINGS.models, openrouter: 'x/y' },
    })
    // Regression: the patch schema must not inject defaults for missing keys.
    const patch = SettingsPatchSchema.parse({ theme: 'dark' })
    expect(patch).toEqual({ theme: 'dark' })
    const next = store.update(patch)
    expect(next.activeProvider).toBe('openrouter')
    expect(next.models.openrouter).toBe('x/y')
    // Partial model maps merge per provider.
    expect(store.update(SettingsPatchSchema.parse({ models: { ollama: 'q' } })).models).toEqual({
      anthropic: '',
      openrouter: 'x/y',
      ollama: 'q',
    })
  })

  it('rejects invalid values', () => {
    const store = new SettingsStore(join(dir, 's.json'))
    expect(() => store.update({ ollamaBaseUrl: 'not a url' })).toThrow()
  })

  it('recovers from a corrupt file', () => {
    const file = join(dir, 's.json')
    writeFileSync(file, '{broken')
    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS)
  })
})

describe('SecretStore', () => {
  it('encrypts secrets at rest and reports status', () => {
    const file = join(dir, 'secrets.json')
    const store = new SecretStore(file, fakeCipher)
    store.set('anthropic', '  sk-ant-secret  ')
    expect(readFileSync(file, 'utf8')).not.toContain('sk-ant-secret')
    expect(store.get('anthropic')).toBe('sk-ant-secret')
    expect(store.status()).toEqual({
      anthropic: true,
      openrouter: false,
      ollama: false,
      encryptionAvailable: true,
    })
  })

  it('clears a secret when set to empty', () => {
    const store = new SecretStore(join(dir, 'secrets.json'), fakeCipher)
    store.set('openrouter', 'k')
    store.set('openrouter', '   ')
    expect(store.get('openrouter')).toBeUndefined()
  })

  it('refuses to store when encryption is unavailable', () => {
    const store = new SecretStore(join(dir, 'secrets.json'), {
      ...fakeCipher,
      isAvailable: () => false,
    })
    expect(() => store.set('anthropic', 'k')).toThrow()
  })
})
