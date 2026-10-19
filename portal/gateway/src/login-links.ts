import { randomUUID } from 'node:crypto'
import type { Database, LoginLink, PortalUser } from './db.js'
import { hashToken, randomToken } from './security.js'

export interface NewLoginLink {
  userId: string
  createdBy: string
  validHours: number
  maxUses: number
  note: string
}

/** Creates a login link; the returned token is shown once (as QR code) and never stored. */
export async function createLoginLink(db: Database, input: NewLoginLink): Promise<{ token: string; link: LoginLink }> {
  const token = randomToken()
  const now = new Date()
  const link: LoginLink = {
    _id: randomUUID(),
    userId: input.userId,
    tokenHash: hashToken(token),
    maxUses: Math.max(1, Math.floor(input.maxUses)),
    uses: 0,
    expiresAt: new Date(now.getTime() + input.validHours * 3_600_000),
    note: input.note.slice(0, 100),
    revokedAt: null,
    createdBy: input.createdBy,
    createdAt: now,
  }
  await db.col.loginLinks.insertOne(link)
  return { token, link }
}

export type RedeemResult =
  | { ok: true; user: PortalUser; link: LoginLink }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' | 'revoked' | 'blocked' }

/** Atomically consumes one use of a login link. */
export async function redeemLoginLink(db: Database, token: string): Promise<RedeemResult> {
  const tokenHash = hashToken(token)
  const now = new Date()
  const link = await db.col.loginLinks.findOneAndUpdate(
    {
      tokenHash,
      revokedAt: null,
      expiresAt: { $gt: now },
      $expr: { $lt: ['$uses', '$maxUses'] },
    },
    { $inc: { uses: 1 } },
    { returnDocument: 'after' },
  )
  if (!link) {
    const existing = await db.col.loginLinks.findOne({ tokenHash })
    if (!existing) return { ok: false, reason: 'invalid' }
    if (existing.revokedAt) return { ok: false, reason: 'revoked' }
    if (existing.expiresAt <= now) return { ok: false, reason: 'expired' }
    return { ok: false, reason: 'used' }
  }
  const user = await db.col.users.findOne({ _id: link.userId })
  if (!user || user.status !== 'active') return { ok: false, reason: 'blocked' }
  return { ok: true, user, link }
}

export async function revokeLoginLink(db: Database, linkId: string): Promise<void> {
  await db.col.loginLinks.updateOne({ _id: linkId, revokedAt: null }, { $set: { revokedAt: new Date() } })
}

export async function listLoginLinks(db: Database, userId: string): Promise<LoginLink[]> {
  return db.col.loginLinks.find({ userId }).sort({ createdAt: -1 }).limit(50).toArray()
}
