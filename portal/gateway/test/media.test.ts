import { mkdtemp } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ObjectId } from 'mongodb'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CREDITS_PER_USD } from '../src/budgets.js'
import { mediaFiles, videoJobs } from '../src/media.js'
import { pollVideoJobs } from '../src/tools/media.js'
import { createUser } from '../src/users.js'
import { type TestEnv, createTestEnv } from './helpers.js'

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

interface Recorded {
  method: string
  path: string
  body: Record<string, unknown> | null
}

const requests: Recorded[] = []
const behaviour = { imageStatus: 200, videoPolls: 0, videoOutcome: 'completed' as 'completed' | 'failed', speechGenerationId: 'gen-1' as string | null }
let server: http.Server
let env: TestEnv
let librechatId: ObjectId

function startOpenRouterMock(): Promise<string> {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString()
      const url = new URL(req.url ?? '/', 'http://mock')
      requests.push({ method: req.method ?? '', path: url.pathname, body: raw ? JSON.parse(raw) : null })
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (url.pathname === '/api/v1/images') {
        if (behaviour.imageStatus !== 200) return json(behaviour.imageStatus, { error: { message: 'provider down' } })
        return json(200, { data: [{ b64_json: PNG.toString('base64'), media_type: 'image/png' }], usage: { cost: 0.04 } })
      }
      if (url.pathname === '/api/v1/audio/speech') {
        res.writeHead(200, { 'content-type': 'audio/mpeg', ...(behaviour.speechGenerationId ? { 'x-generation-id': behaviour.speechGenerationId } : {}) })
        return res.end(Buffer.from('ID3fake-mp3-data'))
      }
      if (url.pathname === '/api/v1/generation') return json(200, { data: { total_cost: 0.0021 } })
      if (url.pathname === '/api/v1/videos' && req.method === 'POST') return json(202, { id: 'vid-1', polling_url: '/api/v1/videos/vid-1', status: 'pending' })
      if (url.pathname === '/api/v1/videos/vid-1') {
        behaviour.videoPolls++
        if (behaviour.videoPolls < 2) return json(200, { id: 'vid-1', status: 'in_progress' })
        return behaviour.videoOutcome === 'failed'
          ? json(200, { id: 'vid-1', status: 'failed', error: 'content policy' })
          : json(200, { id: 'vid-1', status: 'completed', usage: { cost: 0.8 } })
      }
      if (url.pathname === '/api/v1/videos/vid-1/content') {
        res.writeHead(200, { 'content-type': 'video/mp4' })
        return res.end(Buffer.from('....ftypmp42fake-video'))
      }
      json(404, { error: 'no route' })
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`)))
}

beforeAll(async () => {
  const baseUrl = await startOpenRouterMock()
  env = await createTestEnv({
    OPENROUTER_API_KEY: 'sk-or-test',
    OPENROUTER_BASE_URL: baseUrl,
    MEDIA_DIR: await mkdtemp(join(tmpdir(), 'media-')),
  })
  const user = await createUser(env.db, { username: 'kreativ' })
  librechatId = new ObjectId()
  await env.db.librechat.collection('users').insertOne({ _id: librechatId, openidId: user._id })
  await env.db.col.users.updateOne({ _id: user._id }, { $set: { librechatUserId: librechatId } })
})

afterAll(async () => {
  await env.close()
  server.close()
})

beforeEach(async () => {
  requests.length = 0
  Object.assign(behaviour, { imageStatus: 200, videoPolls: 0, videoOutcome: 'completed', speechGenerationId: 'gen-1' })
  await setBalance(5)
})

async function setBalance(usd: number) {
  await env.db.librechat.collection('balances').updateOne({ user: librechatId }, { $set: { tokenCredits: usd * CREDITS_PER_USD } }, { upsert: true })
}

async function balance(): Promise<number> {
  return Number((await env.db.librechat.collection('balances').findOne({ user: librechatId }))!.tokenCredits) / CREDITS_PER_USD
}

async function call(name: string, args: Record<string, unknown>) {
  const res = await env.app.inject({
    method: 'POST',
    url: '/portal/mcp',
    headers: {
      authorization: 'Bearer test-mcp-token',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'x-user-id': librechatId.toHexString(),
    },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  })
  return res.json().result as { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }
}

function text(result: Awaited<ReturnType<typeof call>>): string {
  return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
}

describe('images', () => {
  it('creates an image, shows it in the chat, charges the reported cost and offers a signed download', async () => {
    const result = await call('bild_erstellen', { prompt: 'Ein roter Panda als Astronaut', seitenverhaeltnis: '16:9' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') })
    expect(requests[0]!.body).toMatchObject({ model: 'google/gemini-2.5-flash-image', aspect_ratio: '16:9' })
    expect(await balance()).toBeCloseTo(5 - 0.04, 9)
    const tx = await env.db.librechat.collection('transactions').findOne({ user: librechatId, context: 'media' })
    expect(tx).toMatchObject({ tokenType: 'credits', rawAmount: -40_000, model: 'google/gemini-2.5-flash-image', mediaKind: 'image' })

    const url = new URL(text(result).match(/https?:\/\/\S+/)![0])
    const download = await env.app.inject({ url: url.pathname + url.search })
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-type']).toBe('image/png')
    expect(download.rawPayload.equals(PNG)).toBe(true)
    url.searchParams.set('sig', 'forged')
    expect((await env.app.inject({ url: url.pathname + url.search })).statusCode).toBe(403)
  })

  it('refuses without enough budget and does not call OpenRouter', async () => {
    await setBalance(0.1)
    const result = await call('bild_erstellen', { prompt: 'Ein Sonnenuntergang' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Nicht genug Guthaben')
    expect(requests).toHaveLength(0)
  })

  it('does not charge when OpenRouter fails', async () => {
    behaviour.imageStatus = 502
    const result = await call('bild_erstellen', { prompt: 'Ein Leuchtturm' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('provider down')
    expect(await balance()).toBe(5)
  })

  it('edits only images of the same person', async () => {
    const first = await call('bild_erstellen', { prompt: 'Ein Haus' })
    const id = text(first).match(/Bild-ID: (\S+)/)![1]!
    requests.length = 0
    const edited = await call('bild_bearbeiten', { bild_id: id, anweisung: 'als Aquarell' })
    expect(edited.isError).toBeUndefined()
    const refs = requests[0]!.body!.input_references as { image_url: { url: string } }[]
    expect(refs[0]!.image_url.url.startsWith('data:image/png;base64,')).toBe(true)

    const other = await createUser(env.db, { username: 'fremd' })
    await mediaFiles(env.db).updateOne({ _id: id }, { $set: { userId: other._id } })
    const denied = await call('bild_bearbeiten', { bild_id: id, anweisung: 'heller' })
    expect(denied.isError).toBe(true)
  })
})

describe('speech', () => {
  it('charges the cost from the generation stats', async () => {
    const result = await call('sprache_erstellen', { text: 'Hallo zusammen!' })
    expect(text(result)).toContain('Sprachausgabe erstellt')
    expect(text(result)).not.toContain('geschätzt')
    expect(await balance()).toBeCloseTo(5 - 0.0021, 9)
    expect(requests.find((r) => r.path.endsWith('/audio/speech'))!.body).toMatchObject({ voice: 'alloy', response_format: 'mp3' })
  })

  it('estimates the cost by characters when OpenRouter reports none', async () => {
    behaviour.speechGenerationId = null
    const result = await call('sprache_erstellen', { text: 'x'.repeat(2000) })
    expect(text(result)).toContain('geschätzt')
    expect(await balance()).toBeCloseTo(5 - 0.03, 9)
  })
})

describe('video', () => {
  it('runs asynchronously and is charged exactly once when finished', async () => {
    const started = await call('video_erstellen', { prompt: 'Wellen am Strand', dauer_sekunden: 5 })
    const id = text(started).match(/Video-ID: (\S+)/)![1]!
    expect(await balance()).toBe(5)

    await pollVideoJobs(env.config, env.db) // in_progress
    expect(text(await call('video_status', { video_id: id }))).toContain('wird noch erstellt')

    await Promise.all([pollVideoJobs(env.config, env.db), pollVideoJobs(env.config, env.db)])
    const done = text(await call('video_status', { video_id: id }))
    expect(done).toContain('Das Video ist fertig')
    expect(await balance()).toBeCloseTo(5 - 0.8, 9)
    expect(await env.db.librechat.collection('transactions').countDocuments({ user: librechatId, mediaKind: 'video' })).toBe(1)
  })

  it('charges nothing when the provider fails', async () => {
    behaviour.videoOutcome = 'failed'
    await videoJobs(env.db).deleteMany({})
    const started = await call('video_erstellen', { prompt: 'Verbotenes Motiv' })
    const id = text(started).match(/Video-ID: (\S+)/)![1]!
    await pollVideoJobs(env.config, env.db)
    await pollVideoJobs(env.config, env.db)
    expect(text(await call('video_status', { video_id: id }))).toContain('fehlgeschlagen')
    expect(await balance()).toBe(5)
  })
})
