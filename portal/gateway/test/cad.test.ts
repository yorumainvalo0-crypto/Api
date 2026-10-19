import { mkdtemp } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ObjectId } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cadModels, cadVersions } from '../src/cad.js'
import { createUser } from '../src/users.js'
import { type TestEnv, createTestEnv } from './helpers.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
let server: http.Server
let env: TestEnv
const librechatId = new ObjectId()
const runnerCalls: { code: string; formats: string[] }[] = []

function startRunnerMock(): Promise<string> {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      runnerCalls.push(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (body.code.includes('raise')) {
        return res.end(JSON.stringify({ ok: false, stdout: '', stderr: 'TypeError: Box() missing 1 required positional argument', info: null, files: {} }))
      }
      const b64 = (text: string) => Buffer.from(text).toString('base64')
      res.end(
        JSON.stringify({
          ok: true,
          stdout: '',
          stderr: '',
          info: { size_mm: [60, 40, 10], min_mm: [-30, -20, -5], volume_mm3: 22994.7, area_mm2: 7357, watertight: true, triangles: 120, solids: 1 },
          files: {
            'model.stl': b64('solid test'),
            'model.glb': b64('glTF-fake'),
            'preview.png': PNG,
            ...(body.formats.includes('step') ? { 'model.step': b64('ISO-10303-21;') } : {}),
            ...(body.formats.includes('3mf') ? { 'model.3mf': b64('PK-fake') } : {}),
          },
        }),
      )
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))
}

beforeAll(async () => {
  env = await createTestEnv({ CODE_RUNNER_URL: await startRunnerMock(), MEDIA_DIR: await mkdtemp(join(tmpdir(), 'cad-')) })
  const user = await createUser(env.db, { username: 'konstrukteur' })
  await env.db.librechat.collection('users').insertOne({ _id: librechatId, openidId: user._id })
})

afterAll(async () => {
  await env.close()
  server.close()
})

async function call(args: Record<string, unknown>, conversationId = 'conv-1') {
  const res = await env.app.inject({
    method: 'POST',
    url: '/portal/mcp',
    headers: {
      authorization: 'Bearer test-mcp-token',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'x-user-id': librechatId.toHexString(),
      'x-conversation-id': conversationId,
    },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cad_erstellen', arguments: args } },
  })
  return res.json().result as { content: { type: string; text?: string; data?: string }[]; isError?: boolean }
}

const text = (r: Awaited<ReturnType<typeof call>>) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')

describe('cad_erstellen', () => {
  it('returns preview, dimensions and links, and versions the model by name', async () => {
    const first = await call({ name: 'Rohrhalterung', code: 'from build123d import *\nresult = Box(60, 40, 10)' })
    expect(first.isError).toBeUndefined()
    expect(first.content[0]).toMatchObject({ type: 'image', data: PNG })
    const out = text(first)
    expect(out).toContain('„Rohrhalterung“ – Version 1')
    expect(out).toContain('Maße: 60 × 40 × 10 mm')
    expect(out).toContain('Volumen: 22,99 cm³')
    expect(out).toMatch(/3D-Ansicht .*: https?:\/\/\S+\/portal\/view\//)
    expect(out).toMatch(/STL .*\.stl\?exp=/)
    expect(out).toMatch(/STEP .*\.step\?exp=/)
    expect(out).toMatch(/3MF .*\.3mf\?exp=/)
    expect(runnerCalls.at(-1)!.formats).toEqual(['step', '3mf'])

    const second = await call({ name: 'Rohrhalterung', code: 'from build123d import *\nresult = Box(60, 40, 12)', formate: ['step'] })
    expect(text(second)).toContain('Version 2')
    expect(text(second)).not.toContain('3MF')
    const model = await cadModels(env.db).findOne({ name: 'Rohrhalterung' })
    expect(model!.latestVersion).toBe(2)
    expect(await cadVersions(env.db).countDocuments({ modelId: model!._id })).toBe(2)

    // Same name in another chat is a separate model
    await call({ name: 'Rohrhalterung', code: 'from build123d import *\nresult = Box(1, 1, 1)' }, 'conv-2')
    expect(await cadModels(env.db).countDocuments({ name: 'Rohrhalterung' })).toBe(2)
  })

  it('hands code errors back to Claude without saving a version', async () => {
    const before = await cadVersions(env.db).countDocuments()
    const result = await call({ name: 'Kaputt', code: 'raise TypeError("x")  # test' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('TypeError')
    expect(await cadVersions(env.db).countDocuments()).toBe(before)
  })
})

describe('3D viewer', () => {
  it('opens with a signed link, lists versions and loads three.js from the gateway', async () => {
    const result = await call({ name: 'Viewer-Test', code: 'from build123d import *\nresult = Box(60, 40, 10)' })
    const viewer = new URL(text(result).match(/https?:\/\/\S+\/portal\/view\/\S+/)![0])
    const page = await env.app.inject({ url: viewer.pathname + viewer.search })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Viewer-Test')
    expect(page.body).toContain('60 × 40 × 10 mm')
    expect(page.body).toContain('"three":"/portal/static/three/build/three.module.js"')
    expect(page.body).toContain('Version 1')

    viewer.searchParams.set('sig', 'forged')
    expect((await env.app.inject({ url: viewer.pathname + viewer.search })).statusCode).toBe(403)

    const three = await env.app.inject({ url: '/portal/static/three/build/three.module.js' })
    expect(three.statusCode).toBe(200)
    expect(three.headers['content-type']).toContain('javascript')
    expect((await env.app.inject({ url: '/portal/static/three/examples/jsm/controls/OrbitControls.js' })).statusCode).toBe(200)
    // Nothing outside build/ and examples/jsm/
    expect((await env.app.inject({ url: '/portal/static/three/package.json' })).statusCode).toBe(404)
    expect((await env.app.inject({ url: '/portal/static/three/build/../../../package.json' })).statusCode).toBe(404)
    expect((await env.app.inject({ url: '/portal/static/three/%2e%2e/%2e%2e/src/config.js' })).statusCode).toBe(404)
  })
})
