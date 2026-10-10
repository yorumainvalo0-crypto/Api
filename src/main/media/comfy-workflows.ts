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
    const workflow = parseWorkflowJson(json)
    const placeholders = findPlaceholders(workflow)
    if (
      kind === '3d' &&
      !placeholders.includes('prompt') &&
      !placeholders.includes('input_image')
    ) {
      throw new ComfyError(
        'Der 3D-Workflow braucht {{prompt}} oder {{input_image}} als Platzhalter in einem Eingabefeld.',
      )
    }
    if (kind === 'image' && !placeholders.includes('prompt')) {
      throw new ComfyError('Der Bild-Workflow braucht {{prompt}} als Platzhalter im Prompt-Feld.')
    }
    const info: ComfyWorkflowInfo = {
      id: randomUUID(),
      name: name.trim() || 'Workflow',
      kind,
      placeholders,
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
