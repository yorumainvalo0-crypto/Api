import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

/** URL-safe random token with 256 bits of entropy (QR links, sessions). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** Tokens are stored only as SHA-256 hashes. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, 32, SCRYPT)
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, key] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !key) return false
  const expected = Buffer.from(key, 'base64')
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, SCRYPT)
  return timingSafeEqual(actual, expected)
}

/** AES-256-GCM with a key derived from the portal secret (for values that must be shown again). */
export function encrypt(secret: string, plaintext: string): string {
  const key = createHash('sha256').update(`enc:${secret}`).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.')
}

export function decrypt(secret: string, value: string): string {
  const [iv, tag, data] = value.split('.').map((part) => Buffer.from(part, 'base64url'))
  if (!iv || !tag || !data) throw new Error('invalid ciphertext')
  const key = createHash('sha256').update(`enc:${secret}`).digest()
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

/** HMAC used for CSRF tokens bound to a session. */
export function sign(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

// --- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) for admin two-factor login ---

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function generateTotpSecret(): string {
  const bytes = randomBytes(20)
  let bits = ''
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; i + 5 <= bits.length; i += 5) out += BASE32[parseInt(bits.slice(i, i + 5), 2)]
  return out
}

function base32Decode(secret: string): Buffer {
  let bits = ''
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    const value = BASE32.indexOf(char)
    if (value < 0) throw new Error('invalid base32 secret')
    bits += value.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

export function totpCode(secret: string, timeMs = Date.now()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30_000)))
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary = digest.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 1_000_000).padStart(6, '0')
}

/**
 * Returns the time step a code belongs to, accepting one step before/after for clock drift.
 * Callers store the step so that a code cannot be used twice.
 */
export function totpStep(secret: string, code: string, timeMs = Date.now()): number | null {
  const normalized = code.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(normalized)) return null
  const current = Math.floor(timeMs / 30_000)
  for (const step of [current - 1, current, current + 1]) {
    if (safeEqual(totpCode(secret, step * 30_000), normalized)) return step
  }
  return null
}

export function verifyTotp(secret: string, code: string, timeMs = Date.now()): boolean {
  return totpStep(secret, code, timeMs) !== null
}

export function totpUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}
