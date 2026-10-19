import { describe, expect, it } from 'vitest'
import {
  generateTotpSecret,
  hashPassword,
  hashToken,
  totpCode,
  verifyPassword,
  verifyTotp,
} from '../src/security.js'
import { UserError, normalizeUsername } from '../src/users.js'
import { html, raw } from '../src/html.js'

describe('TOTP', () => {
  // RFC 6238 test secret "12345678901234567890" in base32; at T=59 s the 8-digit code is 94287082
  const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

  it('matches the RFC 6238 test vector', () => {
    expect(totpCode(RFC_SECRET, 59_000)).toBe('287082')
    expect(totpCode(RFC_SECRET, 1_111_111_109_000)).toBe('081804')
  })

  it('accepts one step of clock drift but not more', () => {
    const secret = generateTotpSecret()
    const now = 1_800_000_000_000
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now)).toBe(true)
    expect(verifyTotp(secret, totpCode(secret, now + 30_000), now)).toBe(true)
    expect(verifyTotp(secret, totpCode(secret, now - 90_000), now)).toBe(false)
    expect(verifyTotp(secret, 'abcdef', now)).toBe(false)
  })
})

describe('passwords and tokens', () => {
  it('verifies the right password only', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(stored.startsWith('scrypt$')).toBe(true)
    await expect(verifyPassword('correct horse battery staple', stored)).resolves.toBe(true)
    await expect(verifyPassword('wrong', stored)).resolves.toBe(false)
  })

  it('hashes tokens deterministically', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'))
    expect(hashToken('abc')).not.toBe('abc')
  })
})

describe('usernames', () => {
  it('lowercases valid names', () => {
    expect(normalizeUsername('  Anna.Schmidt ')).toBe('anna.schmidt')
  })

  it.each(['ab', 'x'.repeat(33), 'mit leerzeichen', '-anna', 'anna_', 'ännä', 'admin', 'Claude'])(
    'rejects %s',
    (name) => {
      expect(() => normalizeUsername(name)).toThrow(UserError)
    },
  )
})

describe('html', () => {
  it('escapes interpolations but not trusted markup', () => {
    const value = '<script>alert(1)</script>'
    expect(html`<p>${value}</p>`.value).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
    expect(html`<p>${raw('<b>ok</b>')}</p>`.value).toBe('<p><b>ok</b></p>')
  })
})
