import { ObjectId } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGroup } from '../src/invites.js'
import { createUser } from '../src/users.js'
import { bucketLabel, resolveRange, usageCsv, usageReport } from '../src/usage.js'
import { type TestEnv, cookieHeader, createTestEnv, loginAdmin } from './helpers.js'

let env: TestEnv
const anna = new ObjectId()
const ben = new ObjectId()
let groupId: string

// Recent days in Berlin time, safely inside "last 7 days"
const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
const yesterday = new Date(Date.now() - 86_400_000)

function usage(user: ObjectId, model: string, input: number, output: number, at: Date, rates: [number, number]) {
  return [
    { user, model, tokenType: 'prompt', context: 'message', rawAmount: -input, tokenValue: -input * rates[0], createdAt: at },
    { user, model, tokenType: 'completion', context: 'message', rawAmount: -output, tokenValue: -output * rates[1], createdAt: at },
  ]
}

beforeAll(async () => {
  env = await createTestEnv()
  groupId = (await createGroup(env.db, { name: 'Team', defaultStartBudgetUsd: 0, defaultMonthlyBudgetUsd: 0, createdBy: 't' }))._id
  const a = await createUser(env.db, { username: 'anna', groupId })
  const b = await createUser(env.db, { username: 'ben' })
  await env.db.col.users.updateOne({ _id: a._id }, { $set: { librechatUserId: anna } })
  await env.db.col.users.updateOne({ _id: b._id }, { $set: { librechatUserId: ben } })
  await env.db.librechat.collection('balances').insertMany([
    { user: anna, tokenCredits: 4_500_000 },
    { user: ben, tokenCredits: 1_000_000 },
  ])
  await env.db.librechat.collection('transactions').insertMany([
    // Opus 5.5 ($4 / $20 per 1M): 1000 in + 500 out = 0.014 $
    ...usage(anna, 'claude-opus-5-5', 1000, 500, twoDaysAgo, [4, 20]),
    ...usage(anna, 'claude-opus-5-5', 1000, 500, yesterday, [4, 20]),
    // Haiku title ($0.10 / $0.50): 200 in + 20 out = 0.00003 $
    ...usage(anna, 'claude-haiku-5-5', 200, 20, yesterday, [0.1, 0.5]),
    // Sonnet 5.5 ($2 / $10): 2000 in + 1000 out = 0.014 $
    ...usage(ben, 'claude-sonnet-5-5', 2000, 1000, yesterday, [2, 10]),
    // Image from the media tool: 0.04 $
    { user: ben, tokenType: 'credits', context: 'media', rawAmount: -40_000, tokenValue: -40_000, createdAt: yesterday },
    // Not spending: top-up, monthly reset, outside the range
    { user: anna, tokenType: 'credits', context: 'admin', rawAmount: 5_000_000, tokenValue: 5_000_000, createdAt: yesterday },
    { user: anna, tokenType: 'credits', context: 'balanceReset', rawAmount: -100_000, tokenValue: -100_000, createdAt: yesterday },
    ...usage(ben, 'claude-opus-5-5', 1_000_000, 0, new Date(Date.now() - 40 * 86_400_000), [4, 20]),
  ])
})

afterAll(async () => {
  await env.close()
})

describe('usage report', () => {
  it('sums cost and tokens per person, model and group and ignores credits and resets', async () => {
    const report = await usageReport(env.db, resolveRange('7d'))
    expect(report.totals.costUsd).toBeCloseTo(0.014 * 3 + 0.00003 + 0.04, 9)
    expect(report.totals.inputTokens).toBe(1000 + 1000 + 200 + 2000)
    expect(report.totals.outputTokens).toBe(500 + 500 + 20 + 1000)
    expect(report.totals.requests).toBe(5) // 4 model calls + 1 image
    expect(report.totals.activeUsers).toBe(2)

    expect(report.byUser.map((u) => [u.label, u.group])).toEqual([
      ['ben', '–'],
      ['anna', 'Team'],
    ])
    const annaRow = report.byUser.find((u) => u.label === 'anna')!
    expect(annaRow.costUsd).toBeCloseTo(0.02803, 9)
    expect(annaRow.remainingUsd).toBe(4.5)

    expect(report.byModel.map((m) => m.label)).toEqual(['media', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
    expect(report.byGroup.find((g) => g.label === 'Team')!.costUsd).toBeCloseTo(0.02803, 9)
  })

  it('filters by group', async () => {
    const report = await usageReport(env.db, resolveRange('7d'), groupId)
    expect(report.byUser.map((u) => u.label)).toEqual(['anna'])
    expect(report.totals.costUsd).toBeCloseTo(0.02803, 9)
  })

  it('has one bucket per day (German days) including empty ones', async () => {
    const report = await usageReport(env.db, resolveRange('7d'))
    expect(report.series).toHaveLength(7)
    const day = report.series.find((s) => s.bucket === bucketLabel(twoDaysAgo, 'day'))!
    expect(day.costUsd).toBeCloseTo(0.014, 9)
    expect(report.series.filter((s) => s.costUsd > 0)).toHaveLength(2)
    expect(resolveRange('today').unit).toBe('hour')
    expect((await usageReport(env.db, resolveRange('today'))).series).toHaveLength(24)
  })

  it('assigns late-evening UTC times to the next German day', () => {
    expect(bucketLabel(new Date('2026-07-01T22:30:00Z'), 'day')).toBe('2026-07-02')
    expect(bucketLabel(new Date('2026-12-01T22:30:00Z'), 'day')).toBe('2026-12-01')
  })

  it('exports CSV with German decimals for Excel', async () => {
    const csv = await usageCsv(env.db, resolveRange('7d'))
    expect(csv.startsWith('﻿Datum;Benutzer;Gruppe;Modell;Kosten USD')).toBe(true)
    expect(csv).toContain(';anna;Team;claude-opus-5-5;0,014000;1000;500;1')
    expect(csv).toContain(';ben;;media;0,040000;0;0;1')
  })
})

describe('usage page', () => {
  it('renders tiles, chart and tables for admins only', async () => {
    expect((await env.app.inject({ url: '/portal/admin/usage' })).statusCode).toBe(302)
    const jar = await loginAdmin(env)
    const res = await env.app.inject({ url: '/portal/admin/usage?range=7d', headers: { cookie: cookieHeader(jar) } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<svg viewBox')
    expect(res.body).toContain('id="total-cost">0,082')
    expect(res.body).toContain('claude-sonnet-5-5')
    const csv = await env.app.inject({ url: '/portal/admin/usage.csv?range=7d', headers: { cookie: cookieHeader(jar) } })
    expect(csv.headers['content-type']).toContain('text/csv')
  })
})
