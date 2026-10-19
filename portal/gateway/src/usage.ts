import type { Document, ObjectId } from 'mongodb'
import { CREDITS_PER_USD } from './budgets.js'
import type { Database } from './db.js'
import { parseBerlinLocal } from './invites.js'

export const TIME_ZONE = 'Europe/Berlin'

export type RangeKey = 'today' | '7d' | '30d' | 'month' | 'last-month' | '90d'

export const RANGES: Record<RangeKey, string> = {
  today: 'Heute',
  '7d': 'Letzte 7 Tage',
  '30d': 'Letzte 30 Tage',
  month: 'Dieser Monat',
  'last-month': 'Letzter Monat',
  '90d': 'Letzte 90 Tage',
}

export interface Range {
  key: RangeKey
  from: Date
  to: Date
  /** Bucket size of the time series */
  unit: 'hour' | 'day'
}

function berlinParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  return { year: get('year'), month: get('month'), day: get('day') }
}

function berlinMidnight(year: number, month: number, day: number): Date {
  const iso = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10)
  return parseBerlinLocal(`${iso}T00:00`)!
}

export function resolveRange(key: string | undefined, now = new Date()): Range {
  const rangeKey: RangeKey = key && key in RANGES ? (key as RangeKey) : '30d'
  const { year, month, day } = berlinParts(now)
  const todayStart = berlinMidnight(year, month, day)
  const tomorrow = berlinMidnight(year, month, day + 1)
  switch (rangeKey) {
    case 'today':
      return { key: rangeKey, from: todayStart, to: tomorrow, unit: 'hour' }
    case '7d':
      return { key: rangeKey, from: berlinMidnight(year, month, day - 6), to: tomorrow, unit: 'day' }
    case '90d':
      return { key: rangeKey, from: berlinMidnight(year, month, day - 89), to: tomorrow, unit: 'day' }
    case 'month':
      return { key: rangeKey, from: berlinMidnight(year, month, 1), to: tomorrow, unit: 'day' }
    case 'last-month':
      return { key: rangeKey, from: berlinMidnight(year, month - 1, 1), to: berlinMidnight(year, month, 1), unit: 'day' }
    default:
      return { key: '30d', from: berlinMidnight(year, month, day - 29), to: tomorrow, unit: 'day' }
  }
}

export interface UsageTotals {
  costUsd: number
  inputTokens: number
  outputTokens: number
  requests: number
}

export interface UsageRow extends UsageTotals {
  key: string
  label: string
}

export interface UsageReport {
  range: Range
  totals: UsageTotals & { activeUsers: number }
  series: { bucket: string; costUsd: number; inputTokens: number; outputTokens: number }[]
  byUser: (UsageRow & { group: string; remainingUsd: number | null })[]
  byModel: UsageRow[]
  byGroup: UsageRow[]
}

/**
 * Spending rows in LibreChat's transactions: token usage (prompt/completion, negative values)
 * and media tool charges booked by the gateway (credits with context "media").
 */
function spendingMatch(range: Range, users: ObjectId[] | null): Document {
  return {
    createdAt: { $gte: range.from, $lt: range.to },
    tokenValue: { $lt: 0 },
    $or: [{ tokenType: { $in: ['prompt', 'completion'] } }, { tokenType: 'credits', context: 'media' }],
    ...(users ? { user: { $in: users } } : {}),
  }
}

const SUMS = {
  cost: { $sum: { $multiply: ['$tokenValue', -1] } },
  input: { $sum: { $cond: [{ $eq: ['$tokenType', 'prompt'] }, { $abs: '$rawAmount' }, 0] } },
  output: { $sum: { $cond: [{ $eq: ['$tokenType', 'completion'] }, { $abs: '$rawAmount' }, 0] } },
  // One prompt row per model call; media charges count as one request each
  requests: {
    $sum: { $cond: [{ $or: [{ $eq: ['$tokenType', 'prompt'] }, { $eq: ['$context', 'media'] }] }, 1, 0] },
  },
}

interface Sums {
  _id: unknown
  cost: number
  input: number
  output: number
  requests: number
}

function toTotals(row: Sums | undefined): UsageTotals {
  return {
    costUsd: (row?.cost ?? 0) / CREDITS_PER_USD,
    inputTokens: row?.input ?? 0,
    outputTokens: row?.output ?? 0,
    requests: row?.requests ?? 0,
  }
}

export async function usageReport(db: Database, range: Range, groupId: string | null = null): Promise<UsageReport> {
  const portalUsers = await db.col.users.find(groupId ? { groupId } : {}).toArray()
  const groups = new Map((await db.col.groups.find().toArray()).map((g) => [g._id, g.name]))
  const byLibrechatId = new Map(portalUsers.flatMap((u) => (u.librechatUserId ? [[String(u.librechatUserId), u] as const] : [])))
  const filterUsers = groupId ? portalUsers.flatMap((u) => (u.librechatUserId ? [u.librechatUserId] : [])) : null
  const tx = db.librechat.collection('transactions')
  const match = spendingMatch(range, filterUsers)
  const format = range.unit === 'hour' ? '%Y-%m-%dT%H' : '%Y-%m-%d'

  const [totalsRows, seriesRows, userRows, modelRows, balances] = await Promise.all([
    tx.aggregate<Sums & { users: unknown[] }>([{ $match: match }, { $group: { _id: null, ...SUMS, users: { $addToSet: '$user' } } }]).toArray(),
    tx
      .aggregate<Sums>([
        { $match: match },
        { $group: { _id: { $dateToString: { date: '$createdAt', format, timezone: TIME_ZONE } }, ...SUMS } },
      ])
      .toArray(),
    tx.aggregate<Sums>([{ $match: match }, { $group: { _id: '$user', ...SUMS } }]).toArray(),
    tx.aggregate<Sums>([{ $match: match }, { $group: { _id: { $ifNull: ['$model', 'media'] }, ...SUMS } }]).toArray(),
    db.librechat
      .collection('balances')
      .find({ user: { $in: portalUsers.flatMap((u) => (u.librechatUserId ? [u.librechatUserId] : [])) } })
      .toArray(),
  ])
  const remaining = new Map(balances.map((b) => [String(b.user), (Number(b.tokenCredits) || 0) / CREDITS_PER_USD]))

  // Every bucket of the range, also the empty ones
  const values = new Map(seriesRows.map((r) => [String(r._id), r]))
  const series: UsageReport['series'] = []
  const step = range.unit === 'hour' ? 3_600_000 : 86_400_000
  for (let t = range.from.getTime(); t < range.to.getTime(); t += step) {
    // Day buckets: noon avoids landing on the wrong day around DST switches
    const probe = new Date(range.unit === 'hour' ? t : t + 12 * 3_600_000)
    const bucket = bucketLabel(probe, range.unit)
    if (series.at(-1)?.bucket === bucket) continue
    const row = toTotals(values.get(bucket))
    series.push({ bucket, costUsd: row.costUsd, inputTokens: row.inputTokens, outputTokens: row.outputTokens })
  }

  const byUser = userRows
    .map((r) => {
      const user = byLibrechatId.get(String(r._id))
      return {
        key: String(r._id),
        label: user?.username ?? 'unbekannt',
        group: user?.groupId ? (groups.get(user.groupId) ?? '–') : '–',
        remainingUsd: remaining.get(String(r._id)) ?? null,
        ...toTotals(r),
      }
    })
    .sort((a, b) => b.costUsd - a.costUsd)

  const groupTotals = new Map<string, UsageRow>()
  for (const row of byUser) {
    const current = groupTotals.get(row.group) ?? { key: row.group, label: row.group, costUsd: 0, inputTokens: 0, outputTokens: 0, requests: 0 }
    current.costUsd += row.costUsd
    current.inputTokens += row.inputTokens
    current.outputTokens += row.outputTokens
    current.requests += row.requests
    groupTotals.set(row.group, current)
  }

  const totals = totalsRows[0]
  return {
    range,
    totals: { ...toTotals(totals), activeUsers: totals?.users.length ?? 0 },
    series,
    byUser,
    byModel: modelRows.map((r) => ({ key: String(r._id), label: String(r._id), ...toTotals(r) })).sort((a, b) => b.costUsd - a.costUsd),
    byGroup: [...groupTotals.values()].sort((a, b) => b.costUsd - a.costUsd),
  }
}

export function bucketLabel(date: Date, unit: 'hour' | 'day'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)!.value
  const day = `${get('year')}-${get('month')}-${get('day')}`
  return unit === 'hour' ? `${day}T${get('hour')}` : day
}

/** Per day, person and model – for spreadsheets. */
export async function usageCsv(db: Database, range: Range, groupId: string | null = null): Promise<string> {
  const portalUsers = await db.col.users.find(groupId ? { groupId } : {}).toArray()
  const groups = new Map((await db.col.groups.find().toArray()).map((g) => [g._id, g.name]))
  const byLibrechatId = new Map(portalUsers.flatMap((u) => (u.librechatUserId ? [[String(u.librechatUserId), u] as const] : [])))
  const filterUsers = groupId ? portalUsers.flatMap((u) => (u.librechatUserId ? [u.librechatUserId] : [])) : null
  const rows = await db.librechat
    .collection('transactions')
    .aggregate<Sums & { _id: { day: string; user: ObjectId; model: string } }>([
      { $match: spendingMatch(range, filterUsers) },
      {
        $group: {
          _id: {
            day: { $dateToString: { date: '$createdAt', format: '%Y-%m-%d', timezone: TIME_ZONE } },
            user: '$user',
            model: { $ifNull: ['$model', 'media'] },
          },
          ...SUMS,
        },
      },
      { $sort: { '_id.day': 1 } },
    ])
    .toArray()
  const escape = (raw: string) => {
    // A leading = + - @ would make Excel evaluate the cell as a formula
    const value = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
    return /[";\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
  }
  const decimal = (value: number, digits: number) => value.toFixed(digits).replace('.', ',')
  const lines = ['Datum;Benutzer;Gruppe;Modell;Kosten USD;Tokens Eingabe;Tokens Ausgabe;Anfragen']
  for (const row of rows) {
    const user = byLibrechatId.get(String(row._id.user))
    const totals = toTotals(row)
    lines.push(
      [
        row._id.day,
        escape(user?.username ?? 'unbekannt'),
        escape(user?.groupId ? (groups.get(user.groupId) ?? '') : ''),
        escape(row._id.model),
        decimal(totals.costUsd, 6),
        String(totals.inputTokens),
        String(totals.outputTokens),
        String(totals.requests),
      ].join(';'),
    )
  }
  // BOM so Excel opens umlauts correctly
  return `﻿${lines.join('\r\n')}\r\n`
}
