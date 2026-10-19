import type { Config } from './config.js'
import { MediaError } from './media.js'

/** Minimal client for OpenRouter's media endpoints (images, speech, videos). */
export class OpenRouter {
  constructor(private readonly config: Config) {}

  private get headers(): Record<string, string> {
    if (!this.config.OPENROUTER_API_KEY) throw new MediaError('OpenRouter ist nicht eingerichtet (OPENROUTER_API_KEY fehlt).')
    return {
      authorization: `Bearer ${this.config.OPENROUTER_API_KEY}`,
      'content-type': 'application/json',
      'http-referer': this.config.PUBLIC_URL,
      'x-title': 'A-B Cloud AI Portal',
    }
  }

  private url(path: string): string {
    return `${this.config.OPENROUTER_BASE_URL.replace(/\/+$/, '')}${path}`
  }

  private async fail(res: Response, what: string): Promise<never> {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: { message?: string } | string }
      detail = typeof body.error === 'string' ? body.error : (body.error?.message ?? '')
    } catch {
      // not JSON
    }
    throw new MediaError(`${what} fehlgeschlagen (HTTP ${res.status})${detail ? `: ${detail}` : ''}`)
  }

  async createImage(input: {
    model: string
    prompt: string
    aspectRatio?: string | undefined
    references?: string[] | undefined
  }): Promise<{ data: Buffer; mime: string; costUsd: number | null }> {
    const res = await fetch(this.url('/images'), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        n: 1,
        ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
        ...(input.references?.length
          ? { input_references: input.references.map((url) => ({ type: 'image_url', image_url: { url } })) }
          : {}),
      }),
      signal: AbortSignal.timeout(170_000),
    })
    if (!res.ok) await this.fail(res, 'Bilderzeugung')
    const body = (await res.json()) as { data?: { b64_json?: string; media_type?: string }[]; usage?: { cost?: number } }
    const image = body.data?.[0]
    if (!image?.b64_json) throw new MediaError('Bilderzeugung lieferte kein Bild.')
    return { data: Buffer.from(image.b64_json, 'base64'), mime: image.media_type ?? 'image/png', costUsd: body.usage?.cost ?? null }
  }

  async createSpeech(input: { model: string; text: string; voice: string; instructions?: string | undefined }): Promise<{
    data: Buffer
    mime: string
    generationId: string | null
  }> {
    const res = await fetch(this.url('/audio/speech'), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        model: input.model,
        input: input.text,
        voice: input.voice,
        response_format: 'mp3',
        ...(input.instructions ? { instructions: input.instructions } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) await this.fail(res, 'Sprachausgabe')
    return {
      data: Buffer.from(await res.arrayBuffer()),
      mime: res.headers.get('content-type')?.split(';')[0] ?? 'audio/mpeg',
      generationId: res.headers.get('x-generation-id'),
    }
  }

  /** Cost of a finished request from the generation stats (may take a moment to appear). */
  async generationCost(generationId: string, attempts = 5): Promise<number | null> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const res = await fetch(this.url(`/generation?id=${encodeURIComponent(generationId)}`), { headers: this.headers })
      if (res.ok) {
        const body = (await res.json()) as { data?: { total_cost?: number } }
        if (typeof body.data?.total_cost === 'number') return body.data.total_cost
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
    }
    return null
  }

  async submitVideo(input: {
    model: string
    prompt: string
    duration?: number | undefined
    aspectRatio?: string | undefined
    firstFrame?: string | undefined
  }): Promise<{ id: string }> {
    const res = await fetch(this.url('/videos'), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        ...(input.duration ? { duration: input.duration } : {}),
        ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
        ...(input.firstFrame ? { frame_images: [{ type: 'image_url', image_url: { url: input.firstFrame }, frame_type: 'first_frame' }] } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) await this.fail(res, 'Videoerzeugung')
    const body = (await res.json()) as { id?: string }
    if (!body.id) throw new MediaError('Videoerzeugung lieferte keine Auftrags-ID.')
    return { id: body.id }
  }

  async videoStatus(id: string): Promise<{ status: string; error: string | null; costUsd: number | null }> {
    const res = await fetch(this.url(`/videos/${encodeURIComponent(id)}`), { headers: this.headers, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) await this.fail(res, 'Videostatus')
    const body = (await res.json()) as { status?: string; error?: unknown; usage?: { cost?: number } }
    return {
      status: body.status ?? 'pending',
      error: body.error ? String(typeof body.error === 'object' ? JSON.stringify(body.error) : body.error) : null,
      costUsd: body.usage?.cost ?? null,
    }
  }

  async videoContent(id: string): Promise<{ data: Buffer; mime: string }> {
    const res = await fetch(this.url(`/videos/${encodeURIComponent(id)}/content?index=0`), {
      headers: this.headers,
      signal: AbortSignal.timeout(300_000),
    })
    if (!res.ok) await this.fail(res, 'Video-Download')
    return { data: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type')?.split(';')[0] ?? 'video/mp4' }
  }
}
