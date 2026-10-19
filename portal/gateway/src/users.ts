import { randomInt, randomUUID } from 'node:crypto'
import type { Database, PortalUser, Role } from './db.js'
import { hashPassword } from './security.js'

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/
const RESERVED = new Set([
  'admin',
  'administrator',
  'root',
  'system',
  'support',
  'portal',
  'librechat',
  'anthropic',
  'claude',
  'null',
  'undefined',
])

export class UserError extends Error {}

/** Lowercases and validates a username chosen by a person. */
export function normalizeUsername(input: string): string {
  const username = input.trim().toLowerCase()
  if (!USERNAME_PATTERN.test(username)) {
    throw new UserError(
      'Benutzername: 3–32 Zeichen, nur a–z, 0–9, Punkt, Unterstrich, Bindestrich; nicht mit Sonderzeichen beginnen oder enden.',
    )
  }
  if (RESERVED.has(username)) throw new UserError('Dieser Benutzername ist reserviert.')
  return username
}

/** Admins guard budgets and the dashboard with their password alone, so they need a longer one */
export function minPasswordLength(role: Role): number {
  return role === 'admin' ? 12 : 10
}

export function checkPassword(password: string, role: Role): void {
  const min = minPasswordLength(role)
  if (password.length < min) throw new UserError(`Das Passwort braucht mindestens ${min} Zeichen.`)
  if (password.length > 200) throw new UserError('Das Passwort ist zu lang.')
}

/** Readable random password for the admin to hand out, e.g. "k7mq-p9xr-w3hn" (about 62 bits) */
export function suggestPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const group = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('')
  return [group(), group(), group()].join('-')
}

/** Sets or (with null) removes a user's password; QR logins keep working either way. */
export async function setPassword(db: Database, user: PortalUser, password: string | null): Promise<void> {
  if (password === null) {
    if (user.role === 'admin') throw new UserError('Admins brauchen ein Passwort.')
    await db.col.users.updateOne({ _id: user._id }, { $set: { passwordHash: null } })
    return
  }
  checkPassword(password, user.role)
  await db.col.users.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(password) } })
}

export interface NewUser {
  username: string
  role?: Role
  groupId?: string | null
  inviteId?: string | null
  startBudgetUsd?: number
  monthlyBudgetUsd?: number
  password?: string
}

/** Creates a portal user; fails with UserError when the username is taken. */
export async function createUser(db: Database, input: NewUser): Promise<PortalUser> {
  const username = normalizeUsername(input.username)
  if (input.password) checkPassword(input.password, input.role ?? 'user')
  const user: PortalUser = {
    _id: randomUUID(),
    username,
    role: input.role ?? 'user',
    status: 'active',
    groupId: input.groupId ?? null,
    inviteId: input.inviteId ?? null,
    librechatUserId: null,
    pendingStartBudgetUsd: input.startBudgetUsd ?? 0,
    monthlyBudgetUsd: input.monthlyBudgetUsd ?? 0,
    nextResetAt: null,
    passwordHash: input.password ? await hashPassword(input.password) : null,
    totpSecret: null,
    totpPendingSecret: null,
    createdAt: new Date(),
  }
  try {
    await db.col.users.insertOne(user)
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw new UserError('Dieser Benutzername ist schon vergeben.')
    }
    throw error
  }
  return user
}

/** Technical e-mail address LibreChat requires for every account. */
export function userEmail(username: string, domain: string): string {
  return `${username}@${domain}`
}

/** Creates the first admin from the environment when no admin exists yet. */
export async function bootstrapAdmin(
  db: Database,
  username: string | undefined,
  password: string | undefined,
): Promise<PortalUser | null> {
  if (!username || !password) return null
  const existing = await db.col.users.findOne({ role: 'admin' })
  if (existing) return null
  return createUser(db, { username, password, role: 'admin' })
}

export async function audit(
  db: Database,
  actor: string,
  action: string,
  target: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.col.audit.insertOne({ at: new Date(), actor, action, target, details })
}
