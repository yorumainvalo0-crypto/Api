import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateImages, ImageGenerationError } from '../src/main/media/image-generation'
import { isAllowedPath, isExecutable, listOutputs, outputsDir } from '../src/main/media/outputs'
import { safeOutputName } from '../src/main/media/mcp-server'
import { applyReplyEvent, EMPTY_REPLY } from '@shared/message-parts'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const imageReply = (urls: string[], content = 'Hier ist dein Bild') =>
  jsonResponse(200, {
    choices: [
      {
        message: {
          content,
          images: urls.map((url) => ({ type: 'image_url', image_url: { url } })),
        },
      },
    ],
  })

describe('generateImages', () => {
  it('sends prompt, input images and modalities, and decodes data URLs', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return imageReply([`data:image/png;base64,${PNG}`])
    }) as typeof fetch
    const result = await generateImages({
      prompt: 'Ein Hund',
      model: 'google/x-image',
      apiKey: 'sk-or',
      inputImages: [{ mimeType: 'image/jpeg', base64: 'AAAA' }],
      aspectRatio: '16:9',
      fetchImpl,
    })
    expect(result.images).toHaveLength(1)
    expect(result.images[0]?.mimeType).toBe('image/png')
    expect(result.text).toBe('Hier ist dein Bild')
    expect(bodies[0]).toMatchObject({
      model: 'google/x-image',
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: '16:9' },
      messages: [
        {
          content: [
            { type: 'text', text: 'Ein Hund' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
          ],
        },
      ],
    })
  })

  it('retries image-only models without the text modality and downloads https images', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(init?.body ? JSON.parse(String(init.body)).modalities.join('+') : `GET ${url}`)
      if (url.startsWith('https://cdn')) {
        return new Response(Buffer.from(PNG, 'base64'), {
          headers: { 'content-type': 'image/png' },
        })
      }
      if (calls.length === 1)
        return jsonResponse(400, { error: { message: 'unsupported modality' } })
      return imageReply(['https://cdn.example/img.png'], '')
    }) as typeof fetch
    const result = await generateImages({ prompt: 'x', model: 'flux', apiKey: 'k', fetchImpl })
    expect(calls).toEqual(['image+text', 'image', 'GET https://cdn.example/img.png'])
    expect(result.images[0]?.data.length).toBeGreaterThan(10)
  })

  it('explains missing keys, auth errors, credit problems and image-less replies in German', async () => {
    await expect(generateImages({ prompt: 'x', model: 'm', apiKey: undefined })).rejects.toThrow(
      /OpenRouter API-Key/,
    )
    const respond = (r: Response) => (async () => r) as unknown as typeof fetch
    await expect(
      generateImages({
        prompt: 'x',
        model: 'm',
        apiKey: 'k',
        fetchImpl: respond(jsonResponse(401, {})),
      }),
    ).rejects.toThrow(/ungültig/)
    await expect(
      generateImages({
        prompt: 'x',
        model: 'm',
        apiKey: 'k',
        fetchImpl: respond(jsonResponse(402, {})),
      }),
    ).rejects.toThrow(/Guthaben/)
    await expect(
      generateImages({
        prompt: 'x',
        model: 'm',
        apiKey: 'k',
        fetchImpl: respond(imageReply([], 'Das kann ich nicht malen.')),
      }),
    ).rejects.toThrow(ImageGenerationError)
  })
})

describe('outputs', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-out-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('lists generated files newest first with their kind', async () => {
    writeFileSync(join(dir, 'a.png'), Buffer.from(PNG, 'base64'))
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(join(dir, 'haus.obj'), 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')
    writeFileSync(join(dir, '.hidden'), 'x')
    const files = listOutputs(dir)
    expect(files.map((f) => [f.name, f.kind])).toEqual([
      ['haus.obj', 'model3d'],
      ['a.png', 'image'],
    ])
    expect(listOutputs(join(dir, 'fehlt'))).toEqual([])
  })

  it('places outputs in the chat folder or the project ai-output folder', () => {
    expect(outputsDir('/data', { id: 'c1', mode: 'chat', projectPath: null })).toBe(
      join('/data', 'chats', 'c1', 'outputs'),
    )
    expect(outputsDir('/data', { id: 'c1', mode: 'code', projectPath: '/p' })).toBe(
      join('/p', 'ai-output'),
    )
  })

  it('guards file actions', () => {
    expect(isExecutable('C:\\x\\setup.EXE')).toBe(true)
    expect(isExecutable('/x/run.ps1')).toBe(true)
    expect(isExecutable('/x/bild.png')).toBe(false)
    expect(isAllowedPath(join(dir, 'a.png'), [dir])).toBe(true)
    expect(isAllowedPath('/etc/passwd', [dir])).toBe(false)
    expect(safeOutputName('../../böse:name?.obj', 'x')).toBe('böse_name_.obj')
    expect(safeOutputName('   ', 'fallback.txt')).toBe('fallback.txt')
  })
})

describe('reply reducer with files', () => {
  it('adds produced files as message parts in order', () => {
    const file = {
      name: 'a.png',
      path: '/o/a.png',
      kind: 'image' as const,
      mimeType: 'image/png',
      size: 1,
    }
    let s = applyReplyEvent(EMPTY_REPLY, { chatId: 'c', type: 'text-delta', text: 'Bitte:' })
    s = applyReplyEvent(s, { chatId: 'c', type: 'output-file', file })
    expect(s.parts).toEqual([
      { type: 'text', text: 'Bitte:' },
      { type: 'file', file },
    ])
  })
})
