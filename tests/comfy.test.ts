import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ComfyClient, ComfyError, collectFileRefs } from '../src/main/media/comfy-client'
import {
  builtinImageWorkflow,
  ComfyWorkflowStore,
  dimensions,
  fillWorkflow,
  findPlaceholders,
  parseWorkflowJson,
} from '../src/main/media/comfy-workflows'
import {
  comfyGenerate3d,
  comfyGenerateImage,
  type ComfyConfig,
} from '../src/main/media/comfy-generate'
import { minimalGlb, startMockComfy, type MockComfy } from '../scripts/mock-comfy'

const IMG2IMG = JSON.stringify({
  '1': { class_type: 'LoadImage', inputs: { image: '{{input_image}}' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'style: {{prompt}}' } },
  '3': { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: 20 } },
  '9': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
})
const HUNYUAN_3D = JSON.stringify({
  '1': { class_type: 'LoadImage', inputs: { image: '{{input_image}}' } },
  '2': { class_type: 'Hunyuan3Dv2Conditioning', inputs: { clip_vision_output: ['1', 0] } },
  '9': { class_type: 'SaveGLB', inputs: { mesh: ['2', 0], filename_prefix: 'mesh/3d' } },
})

describe('workflow helpers', () => {
  it('finds and fills placeholders with the right types', () => {
    const wf = parseWorkflowJson(IMG2IMG)
    expect(findPlaceholders(wf)).toEqual(['input_image', 'prompt', 'seed'])
    const filled = fillWorkflow(wf, { prompt: 'Katze', seed: 42, input_image: 'a.png' })
    expect(filled['3']?.inputs['seed']).toBe(42)
    expect(filled['2']?.inputs['text']).toBe('style: Katze')
    expect(filled['1']?.inputs['image']).toBe('a.png')
    // Unknown placeholders stay untouched.
    expect(fillWorkflow(wf, {})['3']?.inputs['seed']).toBe('{{seed}}')
  })

  it('rejects the UI format and invalid files with helpful German messages', () => {
    expect(() => parseWorkflowJson('{"nodes":[],"links":[]}')).toThrow(/Export \(API\)/)
    expect(() => parseWorkflowJson('kein json')).toThrow(ComfyError)
    expect(() => parseWorkflowJson('{}')).toThrow(/API-Format/)
  })

  it('computes sizes from aspect ratios (multiples of 64)', () => {
    expect(dimensions('16:9', 1024)).toEqual({ width: 1024, height: 576 })
    expect(dimensions('9:16', 1024)).toEqual({ width: 576, height: 1024 })
    expect(dimensions(undefined, 512)).toEqual({ width: 512, height: 512 })
  })

  it('collects only final output files', () => {
    expect(
      collectFileRefs({
        '9': {
          images: [
            { filename: 'a.png', type: 'output' },
            { filename: 'b.png', type: 'temp' },
          ],
          text: ['ignored'],
        },
        '10': { '3d': [{ filename: 'm.glb', subfolder: '3d', type: 'output' }] },
      }).map((r) => r.filename),
    ).toEqual(['a.png', 'm.glb'])
  })

  it('builds a valid GLB for the mock', () => {
    const glb = minimalGlb()
    expect(glb.subarray(0, 4).toString()).toBe('glTF')
    expect(glb.readUInt32LE(8)).toBe(glb.length)
  })
})

describe('ComfyUI client and generation (mock server)', () => {
  let comfy: MockComfy
  let dir: string
  beforeAll(async () => {
    comfy = await startMockComfy()
  })
  afterAll(async () => comfy.close())
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-comfy-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const config = (overrides: Partial<ComfyConfig> = {}): ComfyConfig => ({
    url: comfy.url,
    checkpoint: '',
    imageWorkflowId: '',
    resolution: 1024,
    store: new ComfyWorkflowStore(join(dir, 'comfy')),
    pollIntervalMs: 5,
    ...overrides,
  })

  it('checks the connection and lists checkpoints', async () => {
    const client = new ComfyClient({ baseUrl: comfy.url })
    await expect(client.systemStats()).resolves.toEqual({ version: '0.9.9-mock' })
    await expect(client.checkpoints()).resolves.toEqual(['sdxl_base.safetensors', 'sd15.ckpt'])
    await expect(new ComfyClient({ baseUrl: 'http://127.0.0.1:1' }).systemStats()).rejects.toThrow(
      /Keine Verbindung zu ComfyUI/,
    )
  })

  it('runs the built-in workflow with the first checkpoint and downloads the image', async () => {
    const { files, workflowName } = await comfyGenerateImage(config(), {
      prompt: 'Ein Leuchtturm',
      aspectRatio: '16:9',
      inputImages: [],
    })
    expect(workflowName).toContain('sdxl_base.safetensors')
    expect(files.map((f) => [f.filename, f.mimeType])).toEqual([
      ['ai-workbench_00001_.png', 'image/png'],
    ])
    const sent = comfy.prompts.at(-1)
    expect(sent?.['4']?.inputs['ckpt_name']).toBe('sdxl_base.safetensors')
    expect(sent?.['5']?.inputs).toMatchObject({ width: 1024, height: 576 })
    expect(sent?.['6']?.inputs['text']).toBe('Ein Leuchtturm')
    expect(typeof sent?.['3']?.inputs['seed']).toBe('number')
    expect(builtinImageWorkflow()['9']?.class_type).toBe('SaveImage')
  })

  it('uses an imported img2img workflow with an uploaded input image', async () => {
    const store = new ComfyWorkflowStore(join(dir, 'comfy'))
    const wf = store.import('Stil', 'image', IMG2IMG)
    const { files } = await comfyGenerateImage(config({ store, imageWorkflowId: wf.id }), {
      prompt: 'Aquarell',
      inputImages: [{ path: '/x/foto.png', mimeType: 'image/png', data: Buffer.from('png') }],
    })
    expect(files).toHaveLength(1)
    expect(comfy.uploads.at(-1)).toBe('foto.png')
    expect(comfy.prompts.at(-1)?.['1']?.inputs['image']).toBe('foto.png')
  })

  it('refuses image editing with the built-in text-to-image workflow', async () => {
    await expect(
      comfyGenerateImage(config(), {
        prompt: 'x',
        inputImages: [{ path: '/a.png', mimeType: 'image/png', data: Buffer.from('') }],
      }),
    ).rejects.toThrow(/img2img/)
  })

  it('generates a GLB with an imported 3D workflow', async () => {
    const store = new ComfyWorkflowStore(join(dir, 'comfy'))
    const wf = store.import('Hunyuan3D', '3d', HUNYUAN_3D)
    expect(store.list()).toMatchObject([
      { name: 'Hunyuan3D', kind: '3d', placeholders: ['input_image'] },
    ])
    const files = await comfyGenerate3d(config({ store }), {
      workflowId: wf.id,
      prompt: 'Stuhl',
      inputImage: { path: '/x/stuhl.png', mimeType: 'image/png', data: Buffer.from('png') },
    })
    expect(files.map((f) => [f.filename, f.mimeType])).toEqual([
      ['mesh_00001_.glb', 'model/gltf-binary'],
    ])
    expect(files[0]?.data.subarray(0, 4).toString()).toBe('glTF')
    await expect(
      comfyGenerate3d(config({ store }), { workflowId: wf.id, prompt: 'x', inputImage: undefined }),
    ).rejects.toThrow(/Eingabebild/)
    store.remove(wf.id)
    expect(store.list()).toEqual([])
  })

  it('reports rejected workflows (missing nodes) clearly', async () => {
    const store = new ComfyWorkflowStore(join(dir, 'comfy'))
    const wf = store.import(
      'Kaputt',
      'image',
      JSON.stringify({ '1': { class_type: 'MissingNode', inputs: { text: '{{prompt}}' } } }),
    )
    await expect(
      comfyGenerateImage(config({ store, imageWorkflowId: wf.id }), {
        prompt: 'x',
        inputImages: [],
      }),
    ).rejects.toThrow(/Cannot find node MissingNode/)
    expect(() =>
      store.import('Ohne Prompt', 'image', '{"1":{"class_type":"A","inputs":{}}}'),
    ).toThrow(/\{\{prompt\}\}/)
  })
})
