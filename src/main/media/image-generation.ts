import { z } from 'zod'

export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'

export class ImageGenerationError extends Error {
  override name = 'ImageGenerationError'
}

export interface InputImage {
  mimeType: string
  base64: string
}

export interface GeneratedImage {
  mimeType: string
  data: Buffer
}

export interface GenerateImagesArgs {
  prompt: string
  model: string
  apiKey: string | undefined
  inputImages?: InputImage[]
  /** e.g. "1:1", "16:9" – passed to models that support it. */
  aspectRatio?: string | undefined
  fetchImpl?: typeof fetch
  url?: string
}

const ResponseSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({
          content: z.union([z.string(), z.null(), z.array(z.unknown())]).optional(),
          images: z
            .array(z.looseObject({ image_url: z.looseObject({ url: z.string() }) }))
            .optional(),
        }),
      }),
    )
    .min(1),
})

const ErrorSchema = z.looseObject({ error: z.looseObject({ message: z.string() }) })

function parseDataUrl(url: string): GeneratedImage | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url)
  if (!match?.[1] || !match[2]) return undefined
  return { mimeType: match[1], data: Buffer.from(match[2], 'base64') }
}

/**
 * Generates (or edits) images through an OpenRouter image model. Models that output text and
 * images take modalities ["image","text"], image-only models ["image"]; we retry with the latter.
 */
export async function generateImages(
  args: GenerateImagesArgs,
): Promise<{ images: GeneratedImage[]; text: string }> {
  if (!args.apiKey) {
    throw new ImageGenerationError(
      'Für Bildgenerierung wird ein OpenRouter API-Key benötigt (Einstellungen).',
    )
  }
  const doFetch = args.fetchImpl ?? fetch
  const content = [
    { type: 'text', text: args.prompt },
    ...(args.inputImages ?? []).map((img) => ({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    })),
  ]

  const request = async (modalities: string[]) => {
    const response = await doFetch(args.url ?? OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.apiKey}`,
        'content-type': 'application/json',
        'x-title': 'AI Workbench',
      },
      body: JSON.stringify({
        model: args.model,
        messages: [{ role: 'user', content }],
        modalities,
        ...(args.aspectRatio ? { image_config: { aspect_ratio: args.aspectRatio } } : {}),
      }),
      signal: AbortSignal.timeout(180_000),
    })
    const body: unknown = await response.json().catch(() => undefined)
    return { response, body }
  }

  let { response, body } = await request(['image', 'text'])
  if (!response.ok && response.status === 400) {
    // Image-only models reject the "text" output modality.
    ;({ response, body } = await request(['image']))
  }
  if (!response.ok) {
    const message = ErrorSchema.safeParse(body).data?.error.message ?? `HTTP ${response.status}`
    if (response.status === 401 || response.status === 403) {
      throw new ImageGenerationError(`OpenRouter-Key ungültig oder ohne Berechtigung (${message}).`)
    }
    if (response.status === 402) {
      throw new ImageGenerationError('OpenRouter-Guthaben reicht nicht aus.')
    }
    throw new ImageGenerationError(`Bildgenerierung fehlgeschlagen: ${message}`)
  }

  const parsed = ResponseSchema.safeParse(body)
  if (!parsed.success) throw new ImageGenerationError('Unerwartete Antwort von OpenRouter.')
  const message = parsed.data.choices[0]?.message
  const images: GeneratedImage[] = []
  for (const entry of message?.images ?? []) {
    const url = entry.image_url.url
    const fromData = parseDataUrl(url)
    if (fromData) {
      images.push(fromData)
    } else if (/^https:\/\//.test(url)) {
      const download = await doFetch(url, { signal: AbortSignal.timeout(60_000) })
      if (download.ok) {
        images.push({
          mimeType: download.headers.get('content-type') ?? 'image/png',
          data: Buffer.from(await download.arrayBuffer()),
        })
      }
    }
  }
  const text = typeof message?.content === 'string' ? message.content : ''
  if (images.length === 0) {
    throw new ImageGenerationError(
      `Das Modell hat kein Bild geliefert${text ? `: ${text.slice(0, 300)}` : '.'}`,
    )
  }
  return { images, text }
}
