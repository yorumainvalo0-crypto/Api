import { ObjectId } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CREDITS_PER_USD } from '../src/budgets.js'
import { billWebSearches, countWebSearches } from '../src/search.js'
import { resolveRange, usageReport } from '../src/usage.js'
import { type TestEnv, createTestEnv } from './helpers.js'

let env: TestEnv
const user = new ObjectId()

const search = (id: string) => ({ type: 'tool_call', tool_call: { id, name: 'web_search', args: '' } })

function answer(messageId: string, parts: unknown[]) {
  return { messageId, user: user.toHexString(), conversationId: 'c1', isCreatedByUser: false, createdAt: new Date(), content: parts }
}

async function balanceUsd(): Promise<number> {
  return Number((await env.db.librechat.collection('balances').findOne({ user }))!.tokenCredits) / CREDITS_PER_USD
}

beforeAll(async () => {
  env = await createTestEnv()
  await env.db.librechat.collection('balances').insertOne({ user, tokenCredits: 1 * CREDITS_PER_USD })
})

afterAll(async () => {
  await env.close()
})

describe('web search billing', () => {
  it('counts only Anthropic server-side searches', () => {
    expect(
      countWebSearches({
        content: [search('srvtoolu_1'), search('srvtoolu_2'), search('toolu_own_tool'), { type: 'text' }, { type: 'tool_call', tool_call: { id: 'srvtoolu_3', name: 'other' } }],
      }),
    ).toBe(2)
  })

  it('books each search once, also when the job runs twice or in parallel', async () => {
    const messages = env.db.librechat.collection('messages')
    await messages.insertOne(answer('m1', [search('srvtoolu_a'), search('srvtoolu_b'), { type: 'text', text: 'ok' }]))
    await Promise.all([billWebSearches(env.config, env.db), billWebSearches(env.config, env.db)])
    await billWebSearches(env.config, env.db)

    const charges = await env.db.librechat.collection('transactions').find({ user, mediaKind: 'search' }).toArray()
    expect(charges).toHaveLength(1)
    expect(charges[0]).toMatchObject({ context: 'media', model: 'web_search', tokenValue: -20_000, searches: 2, conversationId: 'c1' })
    expect(await balanceUsd()).toBeCloseTo(1 - 0.02, 9)

    // A continued answer with one more search books only the new one
    await messages.updateOne({ messageId: 'm1' }, { $push: { content: search('srvtoolu_c') } as never })
    expect(await billWebSearches(env.config, env.db)).toBe(1)
    expect(await balanceUsd()).toBeCloseTo(1 - 0.03, 9)
  })

  it('shows the searches in the usage dashboard', async () => {
    const report = await usageReport(env.db, resolveRange('7d'))
    expect(report.totals.costUsd).toBeCloseTo(0.03, 9)
  })
})
