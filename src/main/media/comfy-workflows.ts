import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  COMFY_PLACEHOLDERS,
  ComfyWorkflowInfoSchema,
  type ComfyWorkflowInfo,
  type ComfyWorkflowKind,
} from '@shared/schemas/comfy'
import { ComfyError } from './comfy-client'

export type ComfyWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>

const ApiWorkflowSchema = z.record(
  z.string(),
  z.looseObject({ class_type: z.string(), inputs: z.record(z.string(), z.unknown()) }),
)

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g

/** Validates an exported ComfyUI workflow; only the API format can be queued. */
export function parseWorkflowJson(json: string): ComfyWorkflow {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    throw new ComfyError('Die Datei ist kein gültiges JSON.')
  }
  if (data && typeof data === 'object' && 'nodes' in data && 'links' in data) {
    throw new ComfyError(
      'Das ist das normale ComfyUI-Format. Bitte in ComfyUI „Workflow → Export (API)“ verwenden.',
    )
  }
  const parsed = ApiWorkflowSchema.safeParse(data)
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    throw new ComfyError('Kein ComfyUI-Workflow im API-Format erkannt.')
  }
  return parsed.data as ComfyWorkflow
}

/** Names of the {{placeholders}} used in a workflow. */
export function findPlaceholders(workflow: ComfyWorkflow): string[] {
  const found = new Set<string>()
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(PLACEHOLDER)) if (match[1]) found.add(match[1])
    } else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  visit(workflow)
  return [...found].sort()
}

export type PlaceholderValues = Partial<
  Record<(typeof COMFY_PLACEHOLDERS)[number], string | number>
>

/**
 * Replaces {{placeholders}} in all string inputs. A string that is exactly one placeholder takes
 * the value's own type (so {{seed}} becomes a number), otherwise the value is interpolated.
 */
export function fillWorkflow(workflow: ComfyWorkflow, values: PlaceholderValues): ComfyWorkflow {
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const whole = /^\{\{\s*([a-z_]+)\s*\}\}$/.exec(value)
      if (whole?.[1] && whole[1] in values) return values[whole[1] as keyof PlaceholderValues]
      return value.replace(PLACEHOLDER, (m, name: string) =>
        name in values ? String(values[name as keyof PlaceholderValues]) : m,
      )
    }
    if (Array.isArray(value)) return value.map(fill)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]))
    }
    return value
  }
  return fill(workflow) as ComfyWorkflow
}

type Link = [string, number]
const isLink = (v: unknown): v is Link =>
  Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'number'

/** Text fields of prompt encoders (CLIPTextEncode, Flux, SDXL, Qwen edit …). */
const TEXT_FIELDS = ['text', 'prompt', 't5xxl', 'clip_l', 'text_g', 'text_l']
/** Nodes that pass conditioning through; their "conditioning" input is followed. */
const CONDITIONING_INPUTS = ['conditioning', 'conditioning_to', 'positive']

/**
 * Follows a conditioning link back to the node that encodes text. Returns the node id and its
 * string text fields, or null (e.g. ConditioningZeroOut has no text).
 */
function findTextEncoder(
  workflow: ComfyWorkflow,
  link: unknown,
  depth = 0,
): { id: string; fields: string[] } | null {
  if (!isLink(link) || depth > 8) return null
  const node = workflow[link[0]]
  if (!node) return null
  const fields = TEXT_FIELDS.filter((f) => typeof node.inputs[f] === 'string')
  if (fields.length > 0) return { id: link[0], fields }
  for (const key of CONDITIONING_INPUTS) {
    const found = findTextEncoder(workflow, node.inputs[key], depth + 1)
    if (found) return found
  }
  return null
}

/**
 * Inserts {{prompt}}, {{negative}}, {{seed}}, {{width}}/{{height}} and {{input_image}} into a
 * plain ComfyUI API export, so any working workflow can be imported without editing it.
 * Returns the names of what was detected.
 */
export function autoPlaceholders(workflow: ComfyWorkflow): {
  workflow: ComfyWorkflow
  detected: string[]
} {
  const wf: ComfyWorkflow = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow
  const detected = new Set<string>()
  const setText = (target: { id: string; fields: string[] } | null, placeholder: string) => {
    const node = target ? wf[target.id] : undefined
    if (!target || !node) return false
    for (const f of target.fields) node.inputs[f] = `{{${placeholder}}}`
    detected.add(placeholder)
    return true
  }

  let positive: { id: string; fields: string[] } | null = null
  let negative: { id: string; fields: string[] } | null = null
  for (const node of Object.values(wf)) {
    const inputs = node.inputs
    // KSampler, KSamplerAdvanced, CFGGuider: positive/negative inputs.
    positive ??= findTextEncoder(wf, inputs['positive'])
    negative ??= findTextEncoder(wf, inputs['negative'])
    // BasicGuider (Flux): one conditioning input.
    if (/Guider/.test(node.class_type)) positive ??= findTextEncoder(wf, inputs['conditioning'])
  }
  // Fallback: the first node with a text field.
  if (!positive) {
    const id = Object.keys(wf).find((key) =>
      TEXT_FIELDS.some((f) => typeof wf[key]?.inputs[f] === 'string'),
    )
    const node = id ? wf[id] : undefined
    if (id && node)
      positive = { id, fields: TEXT_FIELDS.filter((f) => typeof node.inputs[f] === 'string') }
  }
  setText(positive, 'prompt')
  if (negative && negative.id !== positive?.id) setText(negative, 'negative')

  for (const node of Object.values(wf)) {
    const inputs = node.inputs
    for (const key of ['seed', 'noise_seed']) {
      if (typeof inputs[key] === 'number') {
        inputs[key] = '{{seed}}'
        detected.add('seed')
      }
    }
    const isLatent = /Empty.*Latent|Latent.*Empty/i.test(node.class_type)
    if (
      (isLatent || node.class_type === 'ModelSamplingFlux') &&
      typeof inputs['width'] === 'number' &&
      typeof inputs['height'] === 'number'
    ) {
      inputs['width'] = '{{width}}'
      inputs['height'] = '{{height}}'
      detected.add('width')
      detected.add('height')
    }
  }
  const loadImage = Object.values(wf).find(
    (n) => n.class_type === 'LoadImage' && typeof n.inputs['image'] === 'string',
  )
  if (loadImage) {
    loadImage.inputs['image'] = '{{input_image}}'
    detected.add('input_image')
  }
  return { workflow: wf, detected: [...detected].sort() }
}

/** Width/height for an aspect ratio like "16:9", rounded to multiples of 64. */
export function dimensions(
  aspectRatio: string | undefined,
  longSide: number,
): { width: number; height: number } {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspectRatio?.trim() ?? '')
  const w = match ? Number(match[1]) : 1
  const h = match ? Number(match[2]) : 1
  const round = (n: number) => Math.max(64, Math.round(n / 64) * 64)
  return w >= h
    ? { width: round(longSide), height: round((longSide * h) / w) }
    : { width: round((longSide * w) / h), height: round(longSide) }
}

/** Standard text-to-image graph (works with SD 1.5, SDXL and most single-file checkpoints). */
export function builtinImageWorkflow(): ComfyWorkflow {
  return {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: '{{seed}}',
        steps: 25,
        cfg: 6.5,
        sampler_name: 'euler_ancestral',
        scheduler: 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{checkpoint}}' } },
    '5': {
      class_type: 'EmptyLatentImage',
      inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 },
    },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}', clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'ai-workbench', images: ['8', 0] } },
  }
}

const IndexSchema = z.array(ComfyWorkflowInfoSchema)

/** Imported workflows stored as JSON files next to an index. */
export class ComfyWorkflowStore {
  constructor(private readonly dir: string) {}

  list(): ComfyWorkflowInfo[] {
    try {
      return IndexSchema.catch([]).parse(
        JSON.parse(readFileSync(join(this.dir, 'index.json'), 'utf8')),
      )
    } catch {
      return []
    }
  }

  import(name: string, kind: ComfyWorkflowKind, json: string): ComfyWorkflowInfo {
    let workflow = parseWorkflowJson(json)
    let placeholders = findPlaceholders(workflow)
    // A plain export without placeholders: detect prompt, seed, size and input image.
    let autoDetected = false
    if (placeholders.length === 0) {
      const auto = autoPlaceholders(workflow)
      workflow = auto.workflow
      placeholders = findPlaceholders(workflow)
      autoDetected = auto.detected.length > 0
    }
    if (
      kind === '3d' &&
      !placeholders.includes('prompt') &&
      !placeholders.includes('input_image')
    ) {
      throw new ComfyError(
        'Im 3D-Workflow wurde weder ein Prompt- noch ein Bild-Eingang (LoadImage) gefunden. Bitte {{prompt}} oder {{input_image}} in ein Eingabefeld schreiben.',
      )
    }
    if (kind === 'image' && !placeholders.includes('prompt')) {
      throw new ComfyError(
        'Im Bild-Workflow wurde kein Prompt-Feld gefunden (z. B. CLIPTextEncode). Bitte {{prompt}} in das Prompt-Feld schreiben.',
      )
    }
    const info: ComfyWorkflowInfo = {
      id: randomUUID(),
      name: name.trim() || 'Workflow',
      kind,
      placeholders,
      autoDetected,
      createdAt: Date.now(),
    }
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(join(this.dir, `${info.id}.json`), JSON.stringify(workflow, null, 2), 'utf8')
    this.writeIndex([...this.list(), info])
    return info
  }

  load(id: string): ComfyWorkflow {
    if (!this.list().some((w) => w.id === id)) throw new ComfyError('Workflow nicht gefunden.')
    return parseWorkflowJson(readFileSync(join(this.dir, `${id}.json`), 'utf8'))
  }

  remove(id: string): void {
    rmSync(join(this.dir, `${id}.json`), { force: true })
    this.writeIndex(this.list().filter((w) => w.id !== id))
  }

  private writeIndex(list: ComfyWorkflowInfo[]): void {
    mkdirSync(this.dir, { recursive: true })
    const tmp = join(this.dir, 'index.json.tmp')
    writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8')
    renameSync(tmp, join(this.dir, 'index.json'))
  }
}
