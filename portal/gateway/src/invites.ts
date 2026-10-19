import { randomUUID } from 'node:crypto'
import type { Database, Group, Invite, PortalUser } from './db.js'
import { decrypt, encrypt, hashToken, randomToken } from './security.js'
import { UserError, createUser, normalizeUsername } from './users.js'

export async function createGroup(
  db: Database,
  input: { name: string; defaultStartBudgetUsd: number; defaultMonthlyBudgetUsd: number; createdBy: string },
): Promise<Group> {
  const name = input.name.trim().slice(0, 60)
  if (!name) throw new UserError('Bitte einen Gruppennamen angeben.')
  const group: Group = {
    _id: randomUUID(),
    name,
    defaultStartBudgetUsd: Math.max(0, input.defaultStartBudgetUsd),
    defaultMonthlyBudgetUsd: Math.max(0, input.defaultMonthlyBudgetUsd),
    createdBy: input.createdBy,
    createdAt: new Date(),
  }
  try {
    await db.col.groups.insertOne(group)
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw new UserError('Diese Gruppe gibt es schon.')
    throw error
  }
  return group
}

export interface NewInvite {
  groupId: string
  maxUses: number
  validFrom: Date
  validUntil: Date
  startBudgetUsd: number
  monthlyBudgetUsd: number
  note: string
  createdBy: string
}

export async function createInvite(db: Database, secret: string, input: NewInvite): Promise<{ token: string; invite: Invite }> {
  if (!(input.validUntil > input.validFrom)) throw new UserError('Das Ende muss nach dem Beginn liegen.')
  if (input.validUntil <= new Date()) throw new UserError('Das Ende liegt in der Vergangenheit.')
  const token = randomToken()
  const invite: Invite = {
    _id: randomUUID(),
    groupId: input.groupId,
    tokenHash: hashToken(token),
    tokenEncrypted: encrypt(secret, token),
    maxUses: Math.min(500, Math.max(1, Math.floor(input.maxUses))),
    uses: 0,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    startBudgetUsd: Math.max(0, input.startBudgetUsd),
    monthlyBudgetUsd: Math.max(0, input.monthlyBudgetUsd),
    note: input.note.trim().slice(0, 100),
    revokedAt: null,
    createdBy: input.createdBy,
    createdAt: new Date(),
  }
  await db.col.invites.insertOne(invite)
  return { token, invite }
}

export function inviteToken(secret: string, invite: Invite): string {
  return decrypt(secret, invite.tokenEncrypted)
}

export type InviteState = 'active' | 'not-yet' | 'expired' | 'full' | 'revoked'

export function inviteState(invite: Invite, now = new Date()): InviteState {
  if (invite.revokedAt) return 'revoked'
  if (invite.validUntil <= now) return 'expired'
  if (invite.uses >= invite.maxUses) return 'full'
  if (invite.validFrom > now) return 'not-yet'
  return 'active'
}

export const INVITE_STATE_TEXT: Record<InviteState, string> = {
  active: 'aktiv',
  'not-yet': 'noch nicht gültig',
  expired: 'abgelaufen',
  full: 'alle Plätze vergeben',
  revoked: 'widerrufen',
}

export async function findInvite(db: Database, token: string): Promise<Invite | null> {
  return db.col.invites.findOne({ tokenHash: hashToken(token) })
}

export type JoinResult = { ok: true; user: PortalUser; invite: Invite } | { ok: false; reason: InviteState | 'invalid' | 'username'; message?: string }

/**
 * Claims one seat of the invite atomically and creates the user with the chosen name.
 * If the name is taken the seat is given back, so the invite is not used up by typos.
 */
export async function joinWithInvite(db: Database, token: string, usernameInput: string): Promise<JoinResult> {
  let username: string
  try {
    username = normalizeUsername(usernameInput)
  } catch (error) {
    return { ok: false, reason: 'username', message: (error as Error).message }
  }
  const now = new Date()
  const tokenHash = hashToken(token)
  const invite = await db.col.invites.findOneAndUpdate(
    {
      tokenHash,
      revokedAt: null,
      validFrom: { $lte: now },
      validUntil: { $gt: now },
      $expr: { $lt: ['$uses', '$maxUses'] },
    },
    { $inc: { uses: 1 } },
    { returnDocument: 'after' },
  )
  if (!invite) {
    const existing = await db.col.invites.findOne({ tokenHash })
    return { ok: false, reason: existing ? inviteState(existing, now) : 'invalid' }
  }
  try {
    const user = await createUser(db, {
      username,
      groupId: invite.groupId,
      inviteId: invite._id,
      startBudgetUsd: invite.startBudgetUsd,
      monthlyBudgetUsd: invite.monthlyBudgetUsd,
    })
    return { ok: true, user, invite }
  } catch (error) {
    await db.col.invites.updateOne({ _id: invite._id }, { $inc: { uses: -1 } })
    if (error instanceof UserError) return { ok: false, reason: 'username', message: error.message }
    throw error
  }
}

// --- Europe/Berlin wall-clock times for the admin forms (<input type="datetime-local">) ---

function berlinOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return Math.round((wall - at.getTime()) / 60_000)
}

/** Parses "YYYY-MM-DDTHH:mm" as Berlin local time. */
export function parseBerlinLocal(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const naive = new Date(`${value}:00Z`)
  if (Number.isNaN(naive.getTime())) return null
  let result = new Date(naive.getTime() - berlinOffsetMinutes(naive) * 60_000)
  // Second pass settles the offset around DST switches
  result = new Date(naive.getTime() - berlinOffsetMinutes(result) * 60_000)
  return result
}

/** Formats a date as "YYYY-MM-DDTHH:mm" in Berlin local time (value for datetime-local inputs). */
export function formatBerlinLocal(date: Date): string {
  const shifted = new Date(date.getTime() + berlinOffsetMinutes(date) * 60_000)
  return shifted.toISOString().slice(0, 16)
}
