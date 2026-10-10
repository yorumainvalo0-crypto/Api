import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OcrError, OllamaVision, sameModel, stripThinking } from '../src/main/media/ocr'
import { discoverLocalServices } from '../src/main/media/discovery'
import { startMockOllama, type MockOllama } from '../scripts/mock-ollama'
import { startMockComfy, type MockComfy } from '../scripts/mock-comfy'

describe('OllamaVision (local OCR)', () => {
  let ollama: MockOllama
  beforeAll(async () => {
    ollama = await startMockOllama()
  })
  afterAll(async () => ollama.close())

  const MODEL = 'qwen3-vl:8b-instruct'

  it('reports status, downloads with progress, transcribes and removes the model', async () => {
    const vision = new OllamaVision({ baseUrl: `${ollama.url}/` })
    expect(await vision.status(MODEL)).toMatchObject({ reachable: true, installed: false })

    const progress: number[] = []
    await vision.pull(MODEL, (p) => progress.push(p.total ? p.completed / p.total : -1))
    expect(progress).toContain(0.5)
    expect(await vision.status(MODEL)).toMatchObject({ installed: true, version: '0.20.0-mock' })

    const text = await vision.recognize({
      model: MODEL,
      image: Buffer.from('bild'),
      keepAliveSec: 60,
      hint: 'Brief auf Deutsch',
    })
    expect(text).toBe('Liebe Oma,\ndanke für das Paket!')
    const sent = ollama.chats.at(-1)
    // GPU is released after one minute of inactivity.
    expect(sent?.keep_alive).toBe('60s')
    expect(sent?.messages[0]?.images).toEqual([Buffer.from('bild').toString('base64')])
    expect(sent?.messages[0]?.content).toContain('Handschrift')
    expect(sent?.messages[0]?.content).toContain('Brief auf Deutsch')

    await vision.remove(MODEL)
    expect(ollama.installed.has(MODEL)).toBe(false)
  })

  it('explains missing models, failed downloads and unreachable Ollama in German', async () => {
    const vision = new OllamaVision({ baseUrl: ollama.url })
    await expect(
      vision.recognize({ model: 'fehlt:1b', image: Buffer.from('x'), keepAliveSec: 0 }),
    ).rejects.toThrow(/nicht installiert/)
    await expect(vision.pull('gibtsnicht:1b', () => undefined)).rejects.toThrow(
      /Download fehlgeschlagen/,
    )
    const offline = new OllamaVision({ baseUrl: 'http://127.0.0.1:1' })
    expect(await offline.status(MODEL)).toMatchObject({ reachable: false })
    await expect(offline.installedModels()).rejects.toThrow(OcrError)
  })

  it('matches model names and strips reasoning', () => {
    expect(sameModel('qwen3-vl:latest', 'qwen3-vl')).toBe(true)
    expect(sameModel('qwen3-vl:8b-instruct', 'qwen3-vl:4b-instruct')).toBe(false)
    expect(stripThinking('<think>a\nb</think>Text')).toBe('Text')
  })
})

describe('local service discovery (e.g. Pinokio)', () => {
  let ollama: MockOllama
  let comfy: MockComfy
  beforeAll(async () => {
    ollama = await startMockOllama()
    comfy = await startMockComfy()
  })
  afterAll(async () => {
    await ollama.close()
    await comfy.close()
  })

  it('finds Ollama and ComfyUI on arbitrary ports', async () => {
    const ports = [ollama.url, comfy.url].map((u) => Number(new URL(u).port))
    const found = await discoverLocalServices({ ports: [...ports, 1], timeoutMs: 1000 })
    expect(found.ollama).toEqual([{ url: ollama.url, version: '0.20.0-mock' }])
    expect(found.comfy).toEqual([{ url: comfy.url, version: '0.9.9-mock' }])
  })
})
