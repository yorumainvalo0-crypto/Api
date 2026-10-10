import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { SecretIdSchema, type SecretId, type SecretStatus } from '@shared/schemas/settings'

/** Abstraction over Electron's safeStorage so the store can be tested without Electron. */
export interface Cipher {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

const SecretFileSchema = z.partialRecord(SecretIdSchema, z.string())

/**
 * Stores API keys encrypted with the OS keystore (DPAPI on Windows).
 * Secrets never leave the main process; the renderer only sees which keys exist.
 */
export class SecretStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: Cipher,
  ) {}

  get(provider: SecretId): string | undefined {
    const encoded = this.read()[provider]
    if (!encoded) return undefined
    try {
      return this.cipher.decrypt(Buffer.from(encoded, 'base64'))
    } catch {
      return undefined
    }
  }

  set(provider: SecretId, value: string): void {
    const trimmed = value.trim()
    if (!trimmed) return this.clear(provider)
    if (!this.cipher.isAvailable()) {
      throw new Error('Sichere Verschlüsselung ist auf diesem System nicht verfügbar.')
    }
    const data = this.read()
    data[provider] = this.cipher.encrypt(trimmed).toString('base64')
    this.write(data)
  }

  clear(provider: SecretId): void {
    const { [provider]: _removed, ...rest } = this.read()
    this.write(rest)
  }

  status(): SecretStatus {
    const data = this.read()
    return {
      anthropic: Boolean(data.anthropic),
      openrouter: Boolean(data.openrouter),
      ollama: Boolean(data.ollama),
      typesafe: Boolean(data.typesafe),
      encryptionAvailable: this.cipher.isAvailable(),
    }
  }

  private read(): Partial<Record<SecretId, string>> {
    try {
      const parsed = SecretFileSchema.safeParse(JSON.parse(readFileSync(this.filePath, 'utf8')))
      return parsed.success ? parsed.data : {}
    } catch {
      return {}
    }
  }

  private write(data: Partial<Record<SecretId, string>>): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.filePath)
  }
}
