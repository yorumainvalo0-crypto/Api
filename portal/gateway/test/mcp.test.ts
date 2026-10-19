import { ObjectId } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createUser } from '../src/users.js'
import { type TestEnv, createTestEnv } from './helpers.js'

let env: TestEnv

beforeAll(async () => {
  env = await createTestEnv()
})

afterAll(async () => {
  await env.close()
})

function rpc(method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) {
  return env.app.inject({
    method: 'POST',
    url: '/portal/mcp',
    headers: {
      authorization: 'Bearer test-mcp-token',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    payload: { jsonrpc: '2.0', id: 1, method, params },
  })
}

describe('MCP endpoint', () => {
  it('rejects requests without the shared token', async () => {
    const res = await rpc('tools/list', {}, { authorization: 'Bearer wrong' })
    expect(res.statusCode).toBe(401)
  })

  it('lists tools without a user (LibreChat tool discovery)', async () => {
    const res = await rpc('tools/list', {}, { 'x-user-id': '{{LIBRECHAT_USER_ID}}' })
    expect(res.statusCode).toBe(200)
    const names = res.json().result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(expect.arrayContaining(['konto_status', 'cad_erstellen']))
    // Image, speech and video stay off until MEDIA_ENABLED=true
    expect(names).not.toContain('bild_erstellen')
    expect(names).not.toContain('video_erstellen')
  })

  it('answers konto_status for the LibreChat user behind X-User-ID', async () => {
    const user = await createUser(env.db, { username: 'kontoinhaber', monthlyBudgetUsd: 5 })
    const librechatId = new ObjectId()
    await env.db.librechat.collection('users').insertOne({ _id: librechatId, openidId: user._id, email: 'x@users.test' })
    await env.db.librechat.collection('balances').insertOne({ user: librechatId, tokenCredits: 3_250_000 })

    const res = await rpc('tools/call', { name: 'konto_status', arguments: {} }, { 'x-user-id': librechatId.toHexString() })
    expect(res.statusCode).toBe(200)
    const text = res.json().result.content[0].text as string
    expect(text).toContain('kontoinhaber')
    expect(text).toContain('3.25 USD')
    // The LibreChat id is remembered for later lookups
    expect((await env.db.col.users.findOne({ _id: user._id }))!.librechatUserId).toEqual(librechatId)
  })

  it('refuses tool calls for unknown or blocked users', async () => {
    const res = await rpc('tools/call', { name: 'konto_status', arguments: {} }, { 'x-user-id': new ObjectId().toHexString() })
    expect(res.json().result.isError).toBe(true)
  })
})
