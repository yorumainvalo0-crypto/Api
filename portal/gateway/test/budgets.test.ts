import { ObjectId } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CREDITS_PER_USD, applyMonthlyResets, linkNewUsers, nextMonthStart, topUp } from '../src/budgets.js'
import type { PortalUser } from '../src/db.js'
import { createUser } from '../src/users.js'
import { type TestEnv, cookieHeader, createTestEnv, csrfFrom, loginAdmin } from './helpers.js'

let env: TestEnv

beforeAll(async () => {
  env = await createTestEnv()
})

afterAll(async () => {
  await env.close()
})

async function librechatAccount(user: PortalUser): Promise<ObjectId> {
  const id = new ObjectId()
  await env.db.librechat.collection('users').insertOne({ _id: id, openidId: user._id, username: user.username })
  return id
}

async function balance(id: ObjectId): Promise<number> {
  const doc = await env.db.librechat.collection('balances').findOne({ user: id })
  return Number(doc?.tokenCredits ?? 0)
}

describe('start budget', () => {
  it('is booked exactly once after the first LibreChat login, even with parallel job runs', async () => {
    const user = await createUser(env.db, { username: 'neu', startBudgetUsd: 5, monthlyBudgetUsd: 5 })
    const id = await librechatAccount(user)
    await Promise.all([linkNewUsers(env.db), linkNewUsers(env.db), linkNewUsers(env.db)])
    await linkNewUsers(env.db)

    expect(await balance(id)).toBe(5 * CREDITS_PER_USD)
    const stored = await env.db.col.users.findOne({ _id: user._id })
    expect(stored).toMatchObject({ librechatUserId: id, pendingStartBudgetUsd: 0 })
    expect(stored!.nextResetAt).toBeInstanceOf(Date)
    const tx = await env.db.librechat.collection('transactions').find({ user: id }).toArray()
    expect(tx).toHaveLength(1)
    expect(tx[0]).toMatchObject({ tokenType: 'credits', context: 'admin', rawAmount: 5_000_000 })
  })
})

describe('top-ups', () => {
  it('add to the balance immediately, or to the start budget before the first login', async () => {
    const linked = await createUser(env.db, { username: 'aufladen', startBudgetUsd: 1 })
    const id = await librechatAccount(linked)
    await linkNewUsers(env.db)
    await topUp(env.db, (await env.db.col.users.findOne({ _id: linked._id }))!, 2.5, 'chef')
    expect(await balance(id)).toBe(3.5 * CREDITS_PER_USD)

    const notYet = await createUser(env.db, { username: 'spaeter', startBudgetUsd: 1 })
    await topUp(env.db, notYet, 4, 'chef')
    expect((await env.db.col.users.findOne({ _id: notYet._id }))!.pendingStartBudgetUsd).toBe(5)
  })
})

describe('monthly reset', () => {
  it('sets the balance to the monthly budget without rollover, once per period', async () => {
    const user = await createUser(env.db, { username: 'monatlich', startBudgetUsd: 0, monthlyBudgetUsd: 5 })
    const id = await librechatAccount(user)
    await linkNewUsers(env.db)
    await env.db.librechat.collection('balances').updateOne({ user: id }, { $set: { tokenCredits: 1_234 } }, { upsert: true })
    await env.db.col.users.updateOne({ _id: user._id }, { $set: { nextResetAt: new Date(Date.now() - 1000) } })

    await Promise.all([applyMonthlyResets(env.db), applyMonthlyResets(env.db)])
    expect(await balance(id)).toBe(5 * CREDITS_PER_USD)
    const resets = await env.db.librechat.collection('transactions').find({ user: id, context: 'balanceReset' }).toArray()
    expect(resets).toHaveLength(1)
    expect(resets[0]!.rawAmount).toBe(5 * CREDITS_PER_USD - 1_234)
    const next = (await env.db.col.users.findOne({ _id: user._id }))!.nextResetAt!
    expect(next.getTime()).toBeGreaterThan(Date.now())
  })

  it('leaves users with a monthly budget of 0 alone', async () => {
    const user = await createUser(env.db, { username: 'ohnemonat', startBudgetUsd: 3, monthlyBudgetUsd: 0 })
    const id = await librechatAccount(user)
    await linkNewUsers(env.db)
    await env.db.col.users.updateOne({ _id: user._id }, { $set: { nextResetAt: new Date(Date.now() - 1000) } })
    await applyMonthlyResets(env.db)
    expect(await balance(id)).toBe(3 * CREDITS_PER_USD)
  })

  it('resets at midnight German time on the first of the month', () => {
    // After the switch to winter time: 1 Nov 00:00 CET = 31 Oct 23:00 UTC
    expect(nextMonthStart(new Date('2026-10-19T12:00:00Z')).toISOString()).toBe('2026-10-31T23:00:00.000Z')
    // Summer time: 1 Apr 00:00 CEST = 31 Mar 22:00 UTC
    expect(nextMonthStart(new Date('2026-03-15T12:00:00Z')).toISOString()).toBe('2026-03-31T22:00:00.000Z')
    // 31 Dec 23:30 Berlin → 1 Jan; 1 Jan 00:30 Berlin (31 Dec 23:30 UTC) → 1 Feb
    expect(nextMonthStart(new Date('2026-12-31T22:30:00Z')).toISOString()).toBe('2026-12-31T23:00:00.000Z')
    expect(nextMonthStart(new Date('2026-12-31T23:30:00Z')).toISOString()).toBe('2027-01-31T23:00:00.000Z')
  })
})

describe('admin budget forms', () => {
  it('tops up and changes the monthly budget', async () => {
    const user = await createUser(env.db, { username: 'formular', startBudgetUsd: 1, monthlyBudgetUsd: 2 })
    const id = await librechatAccount(user)
    await linkNewUsers(env.db)
    const jar = await loginAdmin(env)
    const page = await env.app.inject({ url: `/portal/admin/users/${user._id}`, headers: { cookie: cookieHeader(jar) } })
    expect(page.body).toContain('1.00 $')
    const csrf = csrfFrom(page.body)
    const headers = { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) }

    const tooMuch = await env.app.inject({
      method: 'POST',
      url: `/portal/admin/users/${user._id}/topup`,
      headers,
      payload: `_csrf=${csrf}&amountUsd=5000`,
    })
    expect(tooMuch.statusCode).toBe(400)

    await env.app.inject({ method: 'POST', url: `/portal/admin/users/${user._id}/topup`, headers, payload: `_csrf=${csrf}&amountUsd=2,5` })
    await env.app.inject({ method: 'POST', url: `/portal/admin/users/${user._id}/monthly`, headers, payload: `_csrf=${csrf}&monthlyBudgetUsd=10` })
    expect(await balance(id)).toBe(3.5 * CREDITS_PER_USD)
    expect((await env.db.col.users.findOne({ _id: user._id }))!.monthlyBudgetUsd).toBe(10)

    const after = await env.app.inject({ url: `/portal/admin/users/${user._id}`, headers: { cookie: cookieHeader(jar) } })
    expect(after.body).toContain('Aufgeladen')
    expect(after.body).toContain('Startbudget')
    expect(after.body).toContain('3.50 $')
  })
})
