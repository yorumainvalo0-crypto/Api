import { z } from 'zod'

export class OcrError extends Error {
  override name = 'OcrError'
}

/** Vision models that fit an 8 GB GPU (e.g. RTX 4060), best first. */
export const OCR_MODELS = [
  { id: 'qwen3-vl:8b-instruct', label: 'Qwen3-VL 8B (empfohlen, ~6 GB)' },
  { id: 'qwen3-vl:4b-instruct', label: 'Qwen3-VL 4B (schneller, ~3 GB)' },
  { id: 'qwen2.5vl:7b', label: 'Qwen2.5-VL 7B (~6 GB)' },
] as const

export const DEFAULT_OCR_MODEL = OCR_MODELS[0].id

export type OcrMode = 'handwriting' | 'document'

const PROMPTS: Record<OcrMode, string> = {
  handwriting:
    'Transkribiere den gesamten Text in diesem Bild exakt, insbesondere Handschrift. ' +
    'Behalte Zeilenumbrüche und Absätze bei. Gib nur die Transkription aus, ohne Kommentare. ' +
    'Unleserliche Stellen markierst du mit [unleserlich]. Ändere keine Rechtschreibung.',
  document:
    'Lies den gesamten Text in diesem Bild (gedruckt oder handschriftlich) und gib ihn als ' +
    'Markdown wieder: Überschriften als #, Listen als -, Tabellen als Markdown-Tabellen. ' +
    'Gib nur den Inhalt aus, ohne Kommentare. Unleserliches als [unleserlich].',
}

export interface OcrStatus {
  reachable: boolean
  version: string | null
  installed: boolean
  message: string
}

export interface PullProgress {
  status: string
  completed: number
  total: number
}

export interface OllamaVisionOptions {
  baseUrl: string
  fetchImpl?: typeof fetch
}

const TagsSchema = z.looseObject({
  models: z.array(z.looseObject({ name: z.string(), model: z.string().optional() })).default([]),
})

/** Local handwriting/document OCR through an Ollama vision model (runs on the user's GPU). */
export class OllamaVision {
  private readonly fetch: typeof fetch
  private readonly baseUrl: string

  constructor(options: OllamaVisionOptions) {
    this.fetch = options.fetchImpl ?? fetch
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
  }

  private async call(path: string, init?: RequestInit, timeoutMs = 5000): Promise<Response> {
    try {
      return await this.fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new OcrError('Zeitüberschreitung bei Ollama.')
      }
      throw new OcrError(
        `Ollama ist nicht erreichbar (${this.baseUrl}). Ist Ollama installiert und gestartet ` +
          '(auch über Pinokio möglich)?',
      )
    }
  }

  async status(model: string): Promise<OcrStatus> {
    let version: string
    try {
      const response = await this.call('/api/version', undefined, 2500)
      const data = z.looseObject({ version: z.string() }).safeParse(await response.json())
      version = data.success ? data.data.version : 'unbekannt'
    } catch (error) {
      return {
        reachable: false,
        version: null,
        installed: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    const installed = (await this.installedModels()).some((m) => sameModel(m, model))
    return {
      reachable: true,
      version,
      installed,
      message: installed
        ? `Bereit: ${model} (Ollama ${version}).`
        : `Ollama ${version} gefunden – Modell ${model} ist noch nicht heruntergeladen.`,
    }
  }

  async installedModels(): Promise<string[]> {
    const response = await this.call('/api/tags')
    const data = TagsSchema.safeParse(await response.json().catch(() => undefined))
    return data.success ? data.data.models.map((m) => m.name) : []
  }

  /** Downloads a model; reports progress from Ollama's streamed NDJSON. */
  async pull(
    model: string,
    onProgress: (p: PullProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.call('/api/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: signal ?? AbortSignal.timeout(6 * 60 * 60_000),
    })
    if (!response.ok || !response.body) {
      throw new OcrError(`Download fehlgeschlagen (HTTP ${response.status}).`)
    }
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const event = z
          .looseObject({
            status: z.string().optional(),
            completed: z.number().optional(),
            total: z.number().optional(),
            error: z.string().optional(),
          })
          .safeParse(JSON.parse(line))
        if (!event.success) continue
        if (event.data.error) throw new OcrError(`Download fehlgeschlagen: ${event.data.error}`)
        onProgress({
          status: event.data.status ?? '',
          completed: event.data.completed ?? 0,
          total: event.data.total ?? 0,
        })
      }
    }
  }

  async remove(model: string): Promise<void> {
    const response = await this.call('/api/delete', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    })
    if (!response.ok && response.status !== 404) {
      throw new OcrError(`Modell konnte nicht entfernt werden (HTTP ${response.status}).`)
    }
  }

  /**
   * Transcribes an image. The model is loaded onto the GPU only for this request and unloaded
   * again after `keepAliveSec` seconds of inactivity (0 = immediately).
   */
  async recognize(args: {
    model: string
    image: Buffer
    mode?: OcrMode
    keepAliveSec: number
    hint?: string | undefined
  }): Promise<string> {
    const prompt =
      PROMPTS[args.mode ?? 'handwriting'] + (args.hint ? `\nHinweis: ${args.hint}` : '')
    const response = await this.call(
      '/api/chat',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: args.model,
          stream: false,
          keep_alive: `${Math.max(0, Math.round(args.keepAliveSec))}s`,
          options: { temperature: 0, num_ctx: 8192 },
          messages: [{ role: 'user', content: prompt, images: [args.image.toString('base64')] }],
        }),
      },
      5 * 60_000,
    )
    const body: unknown = await response.json().catch(() => undefined)
    if (response.status === 404) {
      throw new OcrError(
        `Das Modell ${args.model} ist nicht installiert. Einstellungen → Handschrift-Erkennung → Herunterladen.`,
      )
    }
    if (!response.ok) {
      const detail = z.looseObject({ error: z.string() }).safeParse(body).data?.error
      throw new OcrError(
        `Texterkennung fehlgeschlagen${detail ? `: ${detail}` : ` (HTTP ${response.status})`}.`,
      )
    }
    const parsed = z
      .looseObject({ message: z.looseObject({ content: z.string() }) })
      .safeParse(body)
    if (!parsed.success) throw new OcrError('Unerwartete Antwort von Ollama.')
    return stripThinking(parsed.data.message.content).trim()
  }
}

/** "qwen3-vl:8b-instruct" matches "qwen3-vl:8b-instruct" and "qwen3-vl:latest" matches "qwen3-vl". */
export function sameModel(installed: string, wanted: string): boolean {
  const norm = (m: string) => (m.includes(':') ? m : `${m}:latest`)
  return norm(installed) === norm(wanted)
}

/** Some vision models wrap their reasoning in <think> tags; drop it. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '')
}
