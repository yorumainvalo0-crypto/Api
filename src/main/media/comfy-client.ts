import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export class ComfyError extends Error {
  override name = 'ComfyError'
}

/** A file produced by a ComfyUI run (image, mesh, video …). */
export interface ComfyOutputFile {
  filename: string
  mimeType: string
  data: Buffer
}

export interface ComfyClientOptions {
  baseUrl: string
  fetchImpl?: typeof fetch
  /** Max time for one generation (3D can take several minutes). */
  timeoutMs?: number
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
}

const QueueResponseSchema = z.looseObject({
  prompt_id: z.string(),
  node_errors: z.record(z.string(), z.unknown()).optional(),
})

const FileRefSchema = z.looseObject({
  filename: z.string(),
  subfolder: z.string().optional(),
  type: z.string().optional(),
})

const HistoryEntrySchema = z.looseObject({
  outputs: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  status: z
    .looseObject({
      status_str: z.string().optional(),
      completed: z.boolean().optional(),
      messages: z.array(z.unknown()).optional(),
    })
    .optional(),
})

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'model/obj',
  stl: 'model/stl',
  ply: 'model/ply',
  mp4: 'video/mp4',
  webm: 'video/webm',
}

function mimeFor(filename: string): string {
  return MIME_BY_EXT[filename.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

/** Collects every {filename, subfolder, type} reference from a node's outputs. */
export function collectFileRefs(
  outputs: Record<string, Record<string, unknown>>,
): z.infer<typeof FileRefSchema>[] {
  const refs: z.infer<typeof FileRefSchema>[] = []
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const parsed = FileRefSchema.safeParse(value)
    if (parsed.success) refs.push(parsed.data)
  }
  for (const node of Object.values(outputs)) {
    for (const value of Object.values(node)) visit(value)
  }
  // Only final outputs; "temp" files are previews.
  return refs.filter((r) => r.type !== 'temp')
}

/** Minimal client for the ComfyUI HTTP API (queue, poll history, download outputs). */
export class ComfyClient {
  private readonly fetch: typeof fetch
  private readonly baseUrl: string

  constructor(private readonly options: ComfyClientOptions) {
    this.fetch = options.fetchImpl ?? fetch
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
  }

  private async request(path: string, init?: RequestInit, timeoutMs = 15_000): Promise<Response> {
    try {
      return await this.fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new ComfyError(
        `Keine Verbindung zu ComfyUI (${this.baseUrl}). Läuft ComfyUI und stimmt die Adresse?`,
      )
    }
  }

  /** Checks that the server is a ComfyUI instance. */
  async systemStats(): Promise<{ version: string }> {
    const response = await this.request('/system_stats')
    if (!response.ok) throw new ComfyError(`ComfyUI antwortete mit HTTP ${response.status}.`)
    const data = z
      .looseObject({ system: z.looseObject({ comfyui_version: z.string().optional() }).optional() })
      .safeParse(await response.json().catch(() => undefined))
    if (!data.success) throw new ComfyError('Unter dieser Adresse läuft kein ComfyUI.')
    return { version: data.data.system?.comfyui_version ?? 'unbekannt' }
  }

  /** Options of a loader node's file input, e.g. UNETLoader.unet_name ([] if unavailable). */
  async nodeOptions(node: string, input: string): Promise<string[]> {
    const response = await this.request(`/object_info/${encodeURIComponent(node)}`)
    if (!response.ok) return []
    const data = z
      .record(
        z.string(),
        z.looseObject({
          input: z.looseObject({ required: z.record(z.string(), z.unknown()).optional() }),
        }),
      )
      .safeParse(await response.json().catch(() => undefined))
    const spec = data.success ? data.data[node]?.input.required?.[input] : undefined
    const options: unknown = Array.isArray(spec) ? spec[0] : undefined
    return Array.isArray(options) ? options.filter((o): o is string => typeof o === 'string') : []
  }

  /** Lists installed checkpoints (for the built-in workflow). */
  async checkpoints(): Promise<string[]> {
    return this.nodeOptions('CheckpointLoaderSimple', 'ckpt_name')
  }

  /** All model files the built-in generator can use (checkpoints and split-file models). */
  async inventory(): Promise<{
    checkpoints: string[]
    diffusionModels: string[]
    textEncoders: string[]
    vaes: string[]
  }> {
    const [checkpoints, diffusionModels, textEncoders, vaes] = await Promise.all([
      this.checkpoints(),
      this.nodeOptions('UNETLoader', 'unet_name'),
      this.nodeOptions('CLIPLoader', 'clip_name'),
      this.nodeOptions('VAELoader', 'vae_name'),
    ])
    return { checkpoints, diffusionModels, textEncoders, vaes }
  }

  /** Uploads an input image; returns the name to reference in a LoadImage node. */
  async uploadImage(filename: string, data: Buffer, mimeType: string): Promise<string> {
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(data)], { type: mimeType }), filename)
    form.append('overwrite', 'true')
    const response = await this.request('/upload/image', { method: 'POST', body: form }, 60_000)
    if (!response.ok)
      throw new ComfyError(`Bild-Upload zu ComfyUI fehlgeschlagen (HTTP ${response.status}).`)
    const parsed = z
      .looseObject({ name: z.string(), subfolder: z.string().optional() })
      .safeParse(await response.json().catch(() => undefined))
    if (!parsed.success) throw new ComfyError('Unerwartete Antwort beim Bild-Upload.')
    return parsed.data.subfolder ? `${parsed.data.subfolder}/${parsed.data.name}` : parsed.data.name
  }

  /** Queues a workflow (API format), waits for completion and downloads all output files. */
  async run(workflow: Record<string, unknown>): Promise<ComfyOutputFile[]> {
    const response = await this.request(
      '/prompt',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }),
      },
      30_000,
    )
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const detail = z
        .looseObject({ error: z.looseObject({ message: z.string() }) })
        .safeParse(body).data?.error.message
      throw new ComfyError(
        `ComfyUI hat den Workflow abgelehnt${detail ? `: ${detail}` : ` (HTTP ${response.status})`}. ` +
          'Fehlen Modelle oder Custom Nodes?',
      )
    }
    const queued = QueueResponseSchema.safeParse(body)
    if (!queued.success) throw new ComfyError('Unerwartete Antwort von ComfyUI.')

    const entry = await this.waitForHistory(queued.data.prompt_id)
    if (entry.status?.status_str === 'error') {
      throw new ComfyError(
        'Die Generierung in ComfyUI ist fehlgeschlagen (Details im ComfyUI-Log).',
      )
    }
    const refs = collectFileRefs(entry.outputs ?? {})
    if (refs.length === 0) throw new ComfyError('Der Workflow hat keine Dateien ausgegeben.')

    const files: ComfyOutputFile[] = []
    for (const ref of refs) {
      const params = new URLSearchParams({
        filename: ref.filename,
        subfolder: ref.subfolder ?? '',
        type: ref.type ?? 'output',
      })
      const download = await this.request(`/view?${params.toString()}`, undefined, 120_000)
      if (!download.ok) continue
      files.push({
        filename: ref.filename,
        mimeType: mimeFor(ref.filename),
        data: Buffer.from(await download.arrayBuffer()),
      })
    }
    if (files.length === 0) throw new ComfyError('Die Ergebnisse konnten nicht geladen werden.')
    return files
  }

  private async waitForHistory(promptId: string): Promise<z.infer<typeof HistoryEntrySchema>> {
    const deadline = Date.now() + (this.options.timeoutMs ?? 15 * 60_000)
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    while (Date.now() < deadline) {
      const response = await this.request(`/history/${encodeURIComponent(promptId)}`)
      if (response.ok) {
        const data = z
          .record(z.string(), HistoryEntrySchema)
          .safeParse(await response.json().catch(() => undefined))
        const entry = data.success ? data.data[promptId] : undefined
        // An entry appears once the run finished (successfully or not).
        if (entry && (entry.status?.status_str === 'error' || entry.status?.completed !== false)) {
          return entry
        }
      }
      await sleep(this.options.pollIntervalMs ?? 1000)
    }
    throw new ComfyError('Zeitüberschreitung: ComfyUI hat nicht rechtzeitig geantwortet.')
  }
}
