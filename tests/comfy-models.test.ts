import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chooseModel,
  detectFamily,
  familyWorkflow,
  findCompanions,
  listComfyModels,
  noModelMessage,
  type ComfyInventory,
} from '../src/main/media/comfy-models'
import {
  autoPlaceholders,
  ComfyWorkflowStore,
  type ComfyWorkflow,
} from '../src/main/media/comfy-workflows'
import { comfyGenerateImage } from '../src/main/media/comfy-generate'
import { startMockComfy } from '../scripts/mock-comfy'

const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const zImage: ComfyInventory = {
  checkpoints: [],
  diffusionModels: ['z_image_turbo_bf16.safetensors', 'mystery_model.safetensors'],
  textEncoders: ['qwen_3_4b.safetensors', 'clip_l.safetensors'],
  vaes: ['ae.safetensors'],
}

describe('ComfyUI split-file models', () => {
  it('recognizes model families by file name', () => {
    expect(detectFamily('z_image_turbo_bf16.safetensors')).toBe('z-image')
    expect(detectFamily('flux1-dev-fp8.safetensors')).toBe('flux-dev')
    expect(detectFamily('subfolder/flux1-schnell.safetensors')).toBe('flux-schnell')
    expect(detectFamily('qwen_image_fp8_e4m3fn.safetensors')).toBe('qwen-image')
    expect(detectFamily('qwen_image_edit_2509.safetensors')).toBeNull()
    expect(detectFamily('flux1-kontext-dev.safetensors')).toBeNull()
    expect(detectFamily('wan2.2_t2v.safetensors')).toBeNull()
  })

  it('finds companion files or names exactly what is missing', () => {
    expect(findCompanions('z-image', zImage)).toEqual({
      textEncoders: ['qwen_3_4b.safetensors'],
      vae: 'ae.safetensors',
    })
    expect(findCompanions('flux-dev', zImage)).toEqual({
      missing: ['t5xxl_fp16.safetensors (oder fp8) in models/text_encoders'],
    })
  })

  it('builds the official Z-Image Turbo graph', () => {
    const wf = familyWorkflow(
      'z-image',
      {
        model: 'z_image_turbo_bf16.safetensors',
        textEncoders: ['qwen_3_4b.safetensors'],
        vae: 'ae.safetensors',
      },
      { prompt: 'Katze', negative: 'blurry', seed: 7, width: 1024, height: 768 },
    )
    const byType = (t: string) => Object.values(wf).find((n) => n.class_type === t)?.inputs
    expect(byType('CLIPLoader')).toMatchObject({
      clip_name: 'qwen_3_4b.safetensors',
      type: 'lumina2',
    })
    expect(byType('KSampler')).toMatchObject({
      steps: 9,
      cfg: 1,
      sampler_name: 'euler',
      scheduler: 'simple',
      seed: 7,
    })
    expect(byType('EmptySD3LatentImage')).toMatchObject({ width: 1024, height: 768 })
  })

  it('explains why nothing can run instead of "no checkpoint"', () => {
    const models = listComfyModels({ ...zImage, textEncoders: [], vaes: [] })
    const text = noModelMessage(models)
    expect(text).toContain('„z_image_turbo_bf16.safetensors“ (Z-Image Turbo): es fehlt qwen_3_4b')
    expect(text).toContain('„mystery_model.safetensors“ (diffusion_models): Modelltyp unbekannt')
    expect(() => chooseModel(models, '')).toThrow('Kein nutzbares Bildmodell gefunden')
    expect(chooseModel(listComfyModels(zImage), '').name).toBe('z_image_turbo_bf16.safetensors')
    expect(() => chooseModel(listComfyModels(zImage), 'gone.safetensors')).toThrow(
      'nicht vorhanden',
    )
  })
})

describe('automatic placeholders for plain API exports', () => {
  it('finds prompt, negative, seed and size in a KSampler graph', () => {
    const wf: ComfyWorkflow = {
      '3': {
        class_type: 'KSampler',
        inputs: {
          seed: 123,
          steps: 9,
          positive: ['6', 0],
          negative: ['7', 0],
          latent_image: ['13', 0],
          model: ['16', 0],
        },
      },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['18', 0] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['18', 0] } },
      '13': {
        class_type: 'EmptySD3LatentImage',
        inputs: { width: 1024, height: 1024, batch_size: 1 },
      },
      '16': {
        class_type: 'UNETLoader',
        inputs: { unet_name: 'z.safetensors', weight_dtype: 'default' },
      },
      '18': { class_type: 'CLIPLoader', inputs: { clip_name: 'q.safetensors', type: 'lumina2' } },
    }
    const { workflow, detected } = autoPlaceholders(wf)
    expect(detected).toEqual(['height', 'negative', 'prompt', 'seed', 'width'])
    expect(workflow['6']?.inputs['text']).toBe('{{prompt}}')
    expect(workflow['7']?.inputs['text']).toBe('{{negative}}')
    expect(workflow['3']?.inputs['seed']).toBe('{{seed}}')
    // Model file names stay untouched.
    expect(workflow['16']?.inputs['unet_name']).toBe('z.safetensors')
  })

  it('follows Flux guiders through FluxGuidance', () => {
    const wf: ComfyWorkflow = {
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cake', clip: ['11', 0] } },
      '22': { class_type: 'BasicGuider', inputs: { model: ['30', 0], conditioning: ['26', 0] } },
      '25': { class_type: 'RandomNoise', inputs: { noise_seed: 42 } },
      '26': { class_type: 'FluxGuidance', inputs: { guidance: 3.5, conditioning: ['6', 0] } },
      '27': {
        class_type: 'EmptySD3LatentImage',
        inputs: { width: 1024, height: 1024, batch_size: 1 },
      },
      '30': {
        class_type: 'ModelSamplingFlux',
        inputs: { max_shift: 1.15, base_shift: 0.5, width: 1024, height: 1024, model: ['12', 0] },
      },
    }
    const { workflow, detected } = autoPlaceholders(wf)
    expect(detected).toEqual(['height', 'prompt', 'seed', 'width'])
    expect(workflow['6']?.inputs['text']).toBe('{{prompt}}')
    expect(workflow['25']?.inputs['noise_seed']).toBe('{{seed}}')
    expect(workflow['30']?.inputs['width']).toBe('{{width}}')
  })

  it('imports a plain export without manual placeholders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiw-comfy-auto-'))
    dirs.push(dir)
    const store = new ComfyWorkflowStore(dir)
    const info = store.import(
      'Z-Image',
      'image',
      JSON.stringify({
        '3': {
          class_type: 'KSampler',
          inputs: { seed: 1, positive: ['6', 0], negative: ['7', 0] },
        },
        '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } },
        '7': { class_type: 'CLIPTextEncode', inputs: { text: 'y' } },
      }),
    )
    expect(info).toMatchObject({ autoDetected: true, placeholders: ['negative', 'prompt', 'seed'] })
    expect(() =>
      store.import(
        'Leer',
        'image',
        JSON.stringify({ '1': { class_type: 'VAELoader', inputs: { vae_name: 'ae' } } }),
      ),
    ).toThrow('kein Prompt-Feld gefunden')
  })
})

describe('built-in generation with split-file models (mock ComfyUI)', () => {
  it('runs the Z-Image graph when only diffusion models are installed', async () => {
    const comfy = await startMockComfy({
      unets: ['z_image_turbo_bf16.safetensors'],
      clips: ['qwen_3_4b.safetensors'],
      vaes: ['ae.safetensors'],
    })
    const dir = mkdtempSync(join(tmpdir(), 'aiw-comfy-z-'))
    dirs.push(dir)
    try {
      const result = await comfyGenerateImage(
        {
          url: comfy.url,
          checkpoint: '',
          imageWorkflowId: '',
          resolution: 1024,
          store: new ComfyWorkflowStore(dir),
          pollIntervalMs: 5,
        },
        { prompt: 'Ein Leuchtturm', aspectRatio: '16:9', inputImages: [] },
      )
      expect(result.workflowName).toBe('ComfyUI Z-Image Turbo (z_image_turbo_bf16.safetensors)')
      expect(result.files).toHaveLength(1)
      const sent = Object.values(comfy.prompts.at(-1) ?? {})
      expect(sent.find((n) => n.class_type === 'UNETLoader')?.inputs['unet_name']).toBe(
        'z_image_turbo_bf16.safetensors',
      )
      expect(sent.find((n) => n.class_type === 'CLIPTextEncode')?.inputs['text']).toBe(
        'Ein Leuchtturm',
      )
      expect(sent.find((n) => n.class_type === 'EmptySD3LatentImage')?.inputs).toMatchObject({
        width: 1024,
        height: 576,
      })
    } finally {
      await comfy.close()
    }
  })
})
