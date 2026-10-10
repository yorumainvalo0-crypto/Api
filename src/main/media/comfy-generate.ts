import { basename } from 'node:path'
import { ComfyClient, ComfyError, type ComfyOutputFile } from './comfy-client'
import {
  builtinImageWorkflow,
  dimensions,
  fillWorkflow,
  type ComfyWorkflow,
  type ComfyWorkflowStore,
} from './comfy-workflows'

export interface ComfyConfig {
  url: string
  /** Checkpoint for the built-in workflow; empty = first installed. */
  checkpoint: string
  /** Imported image workflow id; empty = built-in. */
  imageWorkflowId: string
  resolution: number
  store: ComfyWorkflowStore
  fetchImpl?: typeof fetch
  pollIntervalMs?: number
}

export interface ComfyInputImage {
  path: string
  mimeType: string
  data: Buffer
}

const DEFAULT_NEGATIVE = 'blurry, low quality, deformed, watermark, text'

function client(config: ComfyConfig): ComfyClient {
  return new ComfyClient({
    baseUrl: config.url,
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    ...(config.pollIntervalMs !== undefined ? { pollIntervalMs: config.pollIntervalMs } : {}),
  })
}

async function runWorkflow(
  comfy: ComfyClient,
  workflow: ComfyWorkflow,
  values: Record<string, string | number>,
  inputImage: ComfyInputImage | undefined,
): Promise<ComfyOutputFile[]> {
  const filled = { ...values }
  if (inputImage) {
    filled['input_image'] = await comfy.uploadImage(
      basename(inputImage.path),
      inputImage.data,
      inputImage.mimeType,
    )
  }
  return comfy.run(fillWorkflow(workflow, filled))
}

/** Generates images locally with ComfyUI (built-in text-to-image or an imported workflow). */
export async function comfyGenerateImage(
  config: ComfyConfig,
  args: { prompt: string; aspectRatio?: string | undefined; inputImages: ComfyInputImage[] },
): Promise<{ files: ComfyOutputFile[]; workflowName: string }> {
  const comfy = client(config)
  const { width, height } = dimensions(args.aspectRatio, config.resolution)
  const seed = Math.floor(Math.random() * 2 ** 31)
  const values = { prompt: args.prompt, negative: DEFAULT_NEGATIVE, seed, width, height }

  if (config.imageWorkflowId) {
    const info = config.store.list().find((w) => w.id === config.imageWorkflowId)
    const workflow = config.store.load(config.imageWorkflowId)
    if (args.inputImages.length > 0 && !info?.placeholders.includes('input_image')) {
      throw new ComfyError(
        'Der gewählte ComfyUI-Workflow hat kein {{input_image}} – Bildbearbeitung nicht möglich.',
      )
    }
    const files = await runWorkflow(comfy, workflow, values, args.inputImages[0])
    return { files, workflowName: info?.name ?? 'Workflow' }
  }

  if (args.inputImages.length > 0) {
    throw new ComfyError(
      'Der eingebaute ComfyUI-Workflow erzeugt nur neue Bilder. Für Bildbearbeitung einen ' +
        'img2img-Workflow mit {{input_image}} importieren (Einstellungen → Bildgenerierung).',
    )
  }
  let checkpoint = config.checkpoint
  if (!checkpoint) {
    checkpoint = (await comfy.checkpoints())[0] ?? ''
    if (!checkpoint) throw new ComfyError('In ComfyUI ist kein Checkpoint (Modell) installiert.')
  }
  const files = await runWorkflow(
    comfy,
    builtinImageWorkflow(),
    { ...values, checkpoint },
    undefined,
  )
  return { files, workflowName: `ComfyUI (${checkpoint})` }
}

/** Generates a 3D model with an imported ComfyUI 3D workflow (e.g. Hunyuan3D → GLB). */
export async function comfyGenerate3d(
  config: ComfyConfig,
  args: { workflowId: string; prompt: string; inputImage: ComfyInputImage | undefined },
): Promise<ComfyOutputFile[]> {
  const info = config.store.list().find((w) => w.id === args.workflowId)
  if (!info) throw new ComfyError('3D-Workflow nicht gefunden.')
  if (
    info.placeholders.includes('input_image') &&
    !args.inputImage &&
    !info.placeholders.includes('prompt')
  ) {
    throw new ComfyError(`Der 3D-Workflow „${info.name}“ braucht ein Eingabebild.`)
  }
  const seed = Math.floor(Math.random() * 2 ** 31)
  return runWorkflow(
    client(config),
    config.store.load(args.workflowId),
    { prompt: args.prompt, negative: DEFAULT_NEGATIVE, seed },
    args.inputImage,
  )
}
