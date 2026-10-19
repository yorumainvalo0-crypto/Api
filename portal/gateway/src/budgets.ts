import type { ObjectId } from 'mongodb'
import type { Database, PortalUser } from './db.js'
import { audit } from './users.js'

/** 1 USD = 1,000,000 LibreChat credits */
export const CREDITS_PER_USD = 1_000_000

export type BudgetEventType = 'start' | 'topup' | 'reset' | 'monthly-changed'

export interface BudgetEvent {
  at: Date
  userId: string
  type: BudgetEventType
  amountUsd: number
  actor: string
  note: string
}

function credits(usd: number): number {
  return Math.round(usd * CREDITS_PER_USD)
}

function balances(db: Database) {
  return db.librechat.collection('balances')
}

function transactions(db: Database) {
  return db.librechat.collection('transactions')
}

async function recordEvent(db: Database, event: BudgetEvent): Promise<void> {
  await db.portal.collection<BudgetEvent>('budgetEvents').insertOne(event)
}

/** Remaining LibreChat balance in USD (0 when LibreChat has no record yet). */
export async function remainingUsd(db: Database, librechatUserId: ObjectId | null): Promise<number> {
  if (!librechatUserId) return 0
  const balance = await balances(db).findOne({ user: librechatUserId })
  return (Number(balance?.tokenCredits ?? 0) || 0) / CREDITS_PER_USD
}

/** Books a credit the same way LibreChat's add-balance script does (transaction + $inc). */
async function bookCredit(db: Database, user: ObjectId, amountUsd: number, context: string): Promise<void> {
  const value = credits(amountUsd)
  const now = new Date()
  await transactions(db).insertOne({
    user,
    tokenType: 'credits',
    context,
    rawAmount: value,
    tokenValue: value,
    rate: 1,
    createdAt: now,
    updatedAt: now,
  })
  await balances(db).updateOne({ user }, { $inc: { tokenCredits: value } }, { upsert: true })
}

/** Adds credit for the current period ("Limit erweitern"). */
export async function topUp(db: Database, user: PortalUser, amountUsd: number, actor: string, note = ''): Promise<void> {
  if (!(amountUsd > 0)) throw new Error('amount must be positive')
  if (!user.librechatUserId) {
    // Not logged in yet: add to the start budget that is booked on first login
    await db.col.users.updateOne({ _id: user._id }, { $inc: { pendingStartBudgetUsd: amountUsd } })
  } else {
    await bookCredit(db, user.librechatUserId, amountUsd, 'admin')
  }
  await recordEvent(db, { at: new Date(), userId: user._id, type: 'topup', amountUsd, actor, note })
  await audit(db, actor, 'budget.topup', user._id, { amountUsd })
}

export async function setMonthlyBudget(db: Database, user: PortalUser, amountUsd: number, actor: string): Promise<void> {
  await db.col.users.updateOne({ _id: user._id }, { $set: { monthlyBudgetUsd: Math.max(0, amountUsd) } })
  await recordEvent(db, { at: new Date(), userId: user._id, type: 'monthly-changed', amountUsd, actor, note: '' })
  await audit(db, actor, 'budget.monthly-changed', user._id, { amountUsd })
}

/** Midnight (Europe/Berlin) on the first day of the month after `from`. */
export function nextMonthStart(from: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit' }).formatToParts(from)
  const year = Number(parts.find((p) => p.type === 'year')!.value)
  const month = Number(parts.find((p) => p.type === 'month')!.value)
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  // Midnight Berlin is 22:00 or 23:00 UTC the day before; find the UTC hour that formats as 00:00
  for (const hoursBefore of [1, 2]) {
    const candidate = new Date(Date.UTC(nextYear, nextMonth - 1, 1) - hoursBefore * 3_600_000)
    const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(candidate)
    if (hour === '00') return candidate
  }
  return new Date(Date.UTC(nextYear, nextMonth - 1, 1))
}

/**
 * Connects portal users to the LibreChat accounts created on their first login and books the
 * pending start budget exactly once.
 */
export async function linkNewUsers(db: Database, now = new Date()): Promise<number> {
  const pending = await db.col.users.find({ librechatUserId: null }).project<{ _id: string }>({ _id: 1 }).toArray()
  if (!pending.length) return 0
  const accounts = await db.librechat
    .collection('users')
    .find({ openidId: { $in: pending.map((u) => u._id) } }, { projection: { _id: 1, openidId: 1 } })
    .toArray()
  let linked = 0
  for (const account of accounts) {
    const user = await db.col.users.findOneAndUpdate(
      { _id: account.openidId as string, librechatUserId: null },
      { $set: { librechatUserId: account._id } },
      { returnDocument: 'after' },
    )
    if (!user) continue
    linked++
    await applyStartBudget(db, user, now)
  }
  return linked
}

/** Books pendingStartBudgetUsd once (also for users linked by the MCP endpoint) and schedules resets. */
export async function applyStartBudget(db: Database, user: PortalUser, now = new Date()): Promise<void> {
  if (!user.librechatUserId) return
  const claimed = await db.col.users.findOneAndUpdate(
    { _id: user._id, pendingStartBudgetUsd: { $gt: 0 } },
    { $set: { pendingStartBudgetUsd: 0 } },
    { returnDocument: 'before' },
  )
  if (claimed && claimed.pendingStartBudgetUsd > 0) {
    await bookCredit(db, user.librechatUserId, claimed.pendingStartBudgetUsd, 'admin')
    await recordEvent(db, { at: now, userId: user._id, type: 'start', amountUsd: claimed.pendingStartBudgetUsd, actor: 'system', note: '' })
  }
  await db.col.users.updateOne({ _id: user._id, nextResetAt: null }, { $set: { nextResetAt: nextMonthStart(now) } })
}

/**
 * Monthly reset: the balance is set to the monthly budget (no rollover, like refillMode "reset").
 * Users with a monthly budget of 0 keep their balance and only get the next date.
 */
export async function applyMonthlyResets(db: Database, now = new Date()): Promise<number> {
  const due = await db.col.users
    .find({ status: 'active', librechatUserId: { $ne: null }, nextResetAt: { $lte: now } })
    .toArray()
  let count = 0
  for (const user of due) {
    // Claim the reset by moving nextResetAt forward first, so a reset runs only once
    const claimed = await db.col.users.findOneAndUpdate(
      { _id: user._id, nextResetAt: user.nextResetAt },
      { $set: { nextResetAt: nextMonthStart(now) } },
    )
    if (!claimed || !user.librechatUserId || user.monthlyBudgetUsd <= 0) continue
    const target = credits(user.monthlyBudgetUsd)
    const before = await balances(db).findOneAndUpdate(
      { user: user.librechatUserId },
      { $set: { tokenCredits: target } },
      { upsert: true, returnDocument: 'before' },
    )
    const delta = target - (Number(before?.tokenCredits ?? 0) || 0)
    await transactions(db).insertOne({
      user: user.librechatUserId,
      tokenType: 'credits',
      context: 'balanceReset',
      rawAmount: delta,
      tokenValue: delta,
      rate: 1,
      createdAt: now,
      updatedAt: now,
    })
    await recordEvent(db, { at: now, userId: user._id, type: 'reset', amountUsd: user.monthlyBudgetUsd, actor: 'system', note: '' })
    count++
  }
  return count
}

export async function budgetHistory(db: Database, userId: string, limit = 50): Promise<BudgetEvent[]> {
  return db.portal.collection<BudgetEvent>('budgetEvents').find({ userId }).sort({ at: -1 }).limit(limit).toArray()
}

/** Background job: link new accounts quickly, check resets once a minute. */
export function startBudgetJobs(db: Database, log: (error: unknown) => void): () => void {
  let ticks = 0
  const timer = setInterval(() => {
    ticks++
    linkNewUsers(db).catch(log)
    if (ticks % 30 === 0) applyMonthlyResets(db).catch(log)
  }, 2_000)
  return () => clearInterval(timer)
}
