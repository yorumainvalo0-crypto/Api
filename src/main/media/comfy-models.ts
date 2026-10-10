import type { ComfyModelInfo } from '@shared/schemas/comfy'
import { ComfyError } from './comfy-client'
import type { ComfyWorkflow } from './comfy-workflows'

/** Model files ComfyUI reports through its loader nodes. */
export interface ComfyInventory {
  /** models/checkpoints – single files with model, CLIP and VAE. */
  checkpoints: string[]
  /** models/diffusion_models (and unet) – need separate text encoder and VAE. */
  diffusionModels: string[]
  /** models/text_encoders (and clip). */
  textEncoders: string[]
  vaes: string[]
}

/** Split-file model families with a built-in graph taken from the official ComfyUI examples. */
export type ComfyFamily = 'z-image' | 'flux-dev' | 'flux-schnell' | 'qwen-image'

export const FAMILY_LABELS: Record<ComfyFamily, string> = {
  'z-image': 'Z-Image Turbo',
  'flux-dev': 'Flux.1 dev',
  'flux-schnell': 'Flux.1 schnell',
  'qwen-image': 'Qwen-Image',
}

const lower = (s: string) => s.toLowerCase()
const fileName = (s: string) => lower(s.split(/[\\/]/).at(-1) ?? s)

export function detectFamily(diffusionModel: string): ComfyFamily | null {
  const name = fileName(diffusionModel)
  if (/z[_-]?image/.test(name)) return 'z-image'
  if (/qwen[_-]?image/.test(name) && !/edit|layered/.test(name)) return 'qwen-image'
  if (/flux/.test(name) && !/kontext|fill|canny|depth|redux|flux[._-]?2/.test(name)) {
    return /schnell/.test(name) ? 'flux-schnell' : 'flux-dev'
  }
  return null
}

interface Companions {
  textEncoders: string[]
  vae: string
}

const pick = (files: string[], pattern: RegExp) =>
  [...files].sort((a, b) => a.length - b.length).find((f) => pattern.test(fileName(f)))

/** The VAE of Flux and Z-Image is called ae.safetensors (sometimes flux_vae / ae_*). */
const FLUX_VAE = /^ae[._-]|^ae$|flux.*vae|^ae\.sft$/

/** Finds the text encoder(s) and VAE a family needs; lists what is missing. */
export function findCompanions(
  family: ComfyFamily,
  inventory: ComfyInventory,
): Companions | { missing: string[] } {
  const missing: string[] = []
  const need = (files: string[], pattern: RegExp, hint: string) => {
    const found = pick(files, pattern)
    if (!found) missing.push(hint)
    return found ?? ''
  }
  let textEncoders: string[]
  let vae: string
  switch (family) {
    case 'z-image':
      textEncoders = [
        need(
          inventory.textEncoders,
          /qwen[_-]?3[_-]?4b/,
          'qwen_3_4b.safetensors in models/text_encoders',
        ),
      ]
      vae = need(inventory.vaes, FLUX_VAE, 'ae.safetensors in models/vae')
      break
    case 'flux-dev':
    case 'flux-schnell':
      textEncoders = [
        need(
          inventory.textEncoders,
          /t5xxl/,
          't5xxl_fp16.safetensors (oder fp8) in models/text_encoders',
        ),
        need(inventory.textEncoders, /clip_l/, 'clip_l.safetensors in models/text_encoders'),
      ]
      vae = need(inventory.vaes, FLUX_VAE, 'ae.safetensors in models/vae')
      break
    case 'qwen-image':
      textEncoders = [
        need(
          inventory.textEncoders,
          /qwen[_-]?2\.5[_-]?vl/,
          'qwen_2.5_vl_7b (fp8_scaled) in models/text_encoders',
        ),
      ]
      vae = need(
        inventory.vaes,
        /qwen[_-]?image[_-]?vae/,
        'qwen_image_vae.safetensors in models/vae',
      )
      break
  }
  return missing.length > 0 ? { missing } : { textEncoders, vae }
}

export interface GraphValues {
  prompt: string
  negative: string
  seed: number
  width: number
  height: number
}

const save = (images: [string, number]) => ({
  class_type: 'SaveImage',
  inputs: { filename_prefix: 'ai-workbench', images },
})

/** Text-to-image graphs as in the official ComfyUI examples (comfyanonymous.github.io). */
export function familyWorkflow(
  family: ComfyFamily,
  files: { model: string; textEncoders: string[]; vae: string },
  v: GraphValues,
): ComfyWorkflow {
  const latent = {
    class_type: 'EmptySD3LatentImage',
    inputs: { width: v.width, height: v.height, batch_size: 1 },
  }
  switch (family) {
    case 'z-image':
      return {
        '1': {
          class_type: 'UNETLoader',
          inputs: { unet_name: files.model, weight_dtype: 'default' },
        },
        '2': {
          class_type: 'CLIPLoader',
          inputs: { clip_name: files.textEncoders[0], type: 'lumina2', device: 'default' },
        },
        '3': { class_type: 'VAELoader', inputs: { vae_name: files.vae } },
        '4': { class_type: 'CLIPTextEncode', inputs: { text: v.prompt, clip: ['2', 0] } },
        '5': { class_type: 'CLIPTextEncode', inputs: { text: v.negative, clip: ['2', 0] } },
        '6': latent,
        '7': {
          class_type: 'KSampler',
          inputs: {
            seed: v.seed,
            steps: 9,
            cfg: 1,
            sampler_name: 'euler',
            scheduler: 'simple',
            denoise: 1,
            model: ['1', 0],
            positive: ['4', 0],
            negative: ['5', 0],
            latent_image: ['6', 0],
          },
        },
        '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
        '9': save(['8', 0]),
      }
    case 'qwen-image':
      return {
        '1': {
          class_type: 'UNETLoader',
          inputs: { unet_name: files.model, weight_dtype: 'default' },
        },
        '2': {
          class_type: 'CLIPLoader',
          inputs: { clip_name: files.textEncoders[0], type: 'qwen_image', device: 'default' },
        },
        '3': { class_type: 'VAELoader', inputs: { vae_name: files.vae } },
        '4': { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3.1, model: ['1', 0] } },
        '5': { class_type: 'CLIPTextEncode', inputs: { text: v.prompt, clip: ['2', 0] } },
        '6': { class_type: 'CLIPTextEncode', inputs: { text: v.negative, clip: ['2', 0] } },
        '7': latent,
        '8': {
          class_type: 'KSampler',
          inputs: {
            seed: v.seed,
            steps: 20,
            cfg: 2.5,
            sampler_name: 'euler',
            scheduler: 'simple',
            denoise: 1,
            model: ['4', 0],
            positive: ['5', 0],
            negative: ['6', 0],
            latent_image: ['7', 0],
          },
        },
        '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
        '10': save(['9', 0]),
      }
    case 'flux-dev':
    case 'flux-schnell': {
      const dev = family === 'flux-dev'
      return {
        '1': {
          class_type: 'UNETLoader',
          inputs: { unet_name: files.model, weight_dtype: 'default' },
        },
        '2': {
          class_type: 'DualCLIPLoader',
          inputs: {
            clip_name1: files.textEncoders[0],
            clip_name2: files.textEncoders[1],
            type: 'flux',
          },
        },
        '3': { class_type: 'VAELoader', inputs: { vae_name: files.vae } },
        '4': { class_type: 'CLIPTextEncode', inputs: { text: v.prompt, clip: ['2', 0] } },
        '5': latent,
        '6': { class_type: 'RandomNoise', inputs: { noise_seed: v.seed } },
        '7': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
        ...(dev
          ? {
              '8': {
                class_type: 'ModelSamplingFlux',
                inputs: {
                  max_shift: 1.15,
                  base_shift: 0.5,
                  width: v.width,
                  height: v.height,
                  model: ['1', 0],
                },
              },
              '9': {
                class_type: 'FluxGuidance',
                inputs: { guidance: 3.5, conditioning: ['4', 0] },
              },
            }
          : {}),
        '10': {
          class_type: 'BasicScheduler',
          inputs: {
            scheduler: 'simple',
            steps: dev ? 20 : 4,
            denoise: 1,
            model: [dev ? '8' : '1', 0],
          },
        },
        '11': {
          class_type: 'BasicGuider',
          inputs: { model: [dev ? '8' : '1', 0], conditioning: [dev ? '9' : '4', 0] },
        },
        '12': {
          class_type: 'SamplerCustomAdvanced',
          inputs: {
            noise: ['6', 0],
            guider: ['11', 0],
            sampler: ['7', 0],
            sigmas: ['10', 0],
            latent_image: ['5', 0],
          },
        },
        '13': { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['3', 0] } },
        '14': save(['13', 0]),
      }
    }
  }
}

/** Every image model the built-in generator can use, with what is missing for split files. */
export function listComfyModels(inventory: ComfyInventory): ComfyModelInfo[] {
  const checkpoints: ComfyModelInfo[] = inventory.checkpoints.map((name) => ({
    name,
    kind: 'checkpoint',
    family: null,
    familyLabel: null,
    missing: [],
  }))
  const split: ComfyModelInfo[] = inventory.diffusionModels.map((name) => {
    const family = detectFamily(name)
    const companions = family ? findCompanions(family, inventory) : null
    return {
      name,
      kind: 'diffusion',
      family,
      familyLabel: family ? FAMILY_LABELS[family] : null,
      missing: companions && 'missing' in companions ? companions.missing : [],
    }
  })
  return [...checkpoints, ...split]
}

/** Usable = checkpoint, or a recognized split-file model with all companion files. */
export function isUsable(model: ComfyModelInfo): boolean {
  return model.kind === 'checkpoint' || (model.family !== null && model.missing.length === 0)
}

/** German explanation when no built-in graph can run. */
export function noModelMessage(models: ComfyModelInfo[]): string {
  const split = models.filter((m) => m.kind === 'diffusion')
  if (split.length === 0) {
    return (
      'In ComfyUI ist kein Bildmodell installiert (weder in models/checkpoints noch in ' +
      'models/diffusion_models).'
    )
  }
  const lines = split.map((m) =>
    m.family === null
      ? `„${m.name}“ (diffusion_models): Modelltyp unbekannt – bitte einen Workflow importieren.`
      : `„${m.name}“ (${m.familyLabel}): es fehlt ${m.missing.join(', ')}.`,
  )
  return `Kein nutzbares Bildmodell gefunden. ${lines.join(' ')} Eigene Workflows: Einstellungen → Bild- und 3D-Generierung → Bild-Workflow importieren.`
}

/** Resolves the model setting (empty = best available) to something the generator can run. */
export function chooseModel(models: ComfyModelInfo[], wanted: string): ComfyModelInfo {
  if (wanted) {
    const exact = models.find((m) => m.name === wanted)
    if (exact && isUsable(exact)) return exact
    if (exact) throw new ComfyError(noModelMessage([exact]))
    throw new ComfyError(
      `Das eingestellte Modell „${wanted}“ ist in ComfyUI nicht vorhanden. Einstellungen → Bild- und 3D-Generierung → „Verbindung testen“ und Modell neu wählen.`,
    )
  }
  const usable = models.find(isUsable)
  if (!usable) throw new ComfyError(noModelMessage(models))
  return usable
}
