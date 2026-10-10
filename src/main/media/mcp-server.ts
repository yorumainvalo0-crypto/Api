import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { OutputFile } from '@shared/schemas/media'
import { classify, detectMime, MODEL_IMAGE_TYPES, sanitizeName } from '../workspace/attachments'
import { isAllowedPath } from './outputs'
import { generateImages } from './image-generation'
import {
  comfyGenerate3d,
  comfyGenerateImage,
  type ComfyConfig,
  type ComfyInputImage,
} from './comfy-generate'
import type { OllamaVision } from './ocr'

export const MEDIA_MCP_SERVER = 'media'
export const MEDIA_TOOL_NAMES = [
  `mcp__${MEDIA_MCP_SERVER}__generate_image`,
  `mcp__${MEDIA_MCP_SERVER}__save_file`,
  `mcp__${MEDIA_MCP_SERVER}__generate_3d_model`,
  `mcp__${MEDIA_MCP_SERVER}__read_handwriting`,
]

export type ImageBackendConfig =
  | { backend: 'openrouter'; apiKey: string | undefined; model: string }
  | { backend: 'comfyui'; comfy: ComfyConfig }

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

function readInputImage(path: string, roots: string[]): ComfyInputImage {
  if (!isAllowedPath(path, roots))
    throw new Error(`Eingabebild außerhalb der erlaubten Ordner: ${path}`)
  const mimeType = detectMime(path)
  if (!MODEL_IMAGE_TYPES.has(mimeType)) throw new Error(`Kein unterstütztes Bild: ${path}`)
  return { path, mimeType, data: readFileSync(path) }
}

export interface MediaServerOptions {
  /** Folder that receives generated files. */
  outputsDir: string
  /** Folders input images may be read from (chat attachments, project). */
  readableRoots: string[]
  getImageConfig: () => ImageBackendConfig
  /** Local ComfyUI setup used by generate_3d_model (only offered when 3D workflows exist). */
  getComfyConfig?: () => ComfyConfig
  /** Local OCR (Ollama vision model); read_handwriting is only offered when set. */
  ocr?: { vision: OllamaVision; model: string; keepAliveSec: number }
  /** Called for every file written, so the UI can show it inline. */
  onFile: (file: OutputFile) => void
  fetchImpl?: typeof fetch
}

/** Safe file name inside the outputs folder (no paths, no reserved characters). */
export function safeOutputName(name: string, fallback: string): string {
  const cleaned = sanitizeName(name)
  return cleaned === 'datei' && !name.trim() ? fallback : cleaned
}

/** Appends -2, -3 … until the name is free. */
function uniquePath(dir: string, name: string): string {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = join(dir, name)
  for (let i = 2; statSync(candidate, { throwIfNoEntry: false }); i++) {
    candidate = join(dir, `${stem}-${i}${ext}`)
  }
  return candidate
}

function describe(path: string): OutputFile {
  const stat = statSync(path)
  const name = basename(path)
  const mimeType = detectMime(name)
  return {
    name,
    path,
    kind: classify(name, mimeType),
    mimeType,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
  }
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) }
}

/** In-process MCP server for creating media: images via OpenRouter, any file incl. 3D models. */
export function createMediaMcpServer(options: MediaServerOptions) {
  const write = (fileName: string, data: Buffer | string): OutputFile => {
    mkdirSync(options.outputsDir, { recursive: true })
    const path = uniquePath(options.outputsDir, fileName)
    writeFileSync(path, data)
    const file = describe(path)
    options.onFile(file)
    return file
  }

  const comfy = options.getComfyConfig?.()
  const workflows3d = comfy ? comfy.store.list().filter((w) => w.kind === '3d') : []
  const tool3d =
    comfy && workflows3d.length > 0
      ? [
          tool(
            'generate_3d_model',
            'Generates a real 3D model (e.g. GLB) locally with ComfyUI from a text prompt and/or an ' +
              `input image. Available workflows: ${workflows3d.map((w) => `"${w.name}" (${w.placeholders.join(', ')})`).join('; ')}.`,
            {
              prompt: z.string().describe('Description of the object'),
              input_image_path: z
                .string()
                .optional()
                .describe('Absolute path of a reference image'),
              workflow: z.string().optional().describe('Workflow name; default: the first one'),
              file_name: z.string().optional().describe('Base file name without extension'),
            },
            async ({ prompt, input_image_path, workflow, file_name }) => {
              try {
                const chosen =
                  workflows3d.find((w) => w.name.toLowerCase() === workflow?.toLowerCase()) ??
                  workflows3d[0]
                if (!chosen) throw new Error('Kein 3D-Workflow vorhanden.')
                const inputImage = input_image_path
                  ? readInputImage(input_image_path, options.readableRoots)
                  : undefined
                const files = await comfyGenerate3d(comfy, {
                  workflowId: chosen.id,
                  prompt,
                  inputImage,
                })
                const base = safeOutputName(file_name ?? 'modell', 'modell')
                const saved = files.map((f) =>
                  write(`${base}${extname(f.filename) || '.glb'}`, f.data),
                )
                return textResult(
                  [
                    `${saved.length} Datei(en) mit „${chosen.name}“ erzeugt und dem Nutzer angezeigt:`,
                    ...saved.map((f) => `- ${f.path}`),
                  ].join('\n'),
                )
              } catch (error) {
                return textResult(error instanceof Error ? error.message : String(error), true)
              }
            },
          ),
        ]
      : []

  const ocr = options.ocr
  const toolOcr = ocr
    ? [
        tool(
          'read_handwriting',
          "Reads handwriting or printed text from an image LOCALLY on the user's GPU (no cloud) and " +
            'returns the transcription. Use it for handwritten notes, scans and photos of documents, ' +
            'especially when privacy matters or the current model cannot see images.',
          {
            image_path: z
              .string()
              .describe('Absolute path of the image (attachment or project file)'),
            mode: z
              .enum(['handwriting', 'document'])
              .optional()
              .describe('handwriting = exact lines; document = Markdown with headings/tables'),
            hint: z
              .string()
              .optional()
              .describe('Optional context, e.g. language or expected content'),
          },
          async ({ image_path, mode, hint }) => {
            try {
              const image = readInputImage(image_path, options.readableRoots)
              const text = await ocr.vision.recognize({
                model: ocr.model,
                image: image.data,
                mode: mode ?? 'handwriting',
                keepAliveSec: ocr.keepAliveSec,
                hint,
              })
              return textResult(text || '[Kein Text erkannt]')
            } catch (error) {
              return textResult(error instanceof Error ? error.message : String(error), true)
            }
          },
          { annotations: { readOnlyHint: true } },
        ),
      ]
    : []

  return createSdkMcpServer({
    name: MEDIA_MCP_SERVER,
    version: '1.0.0',
    instructions:
      'generate_image creates or edits pictures. save_file stores any text file for the user; ' +
      'for 3D models write Wavefront OBJ (preferred), ASCII STL, ASCII PLY or glTF JSON with the ' +
      'matching extension – the app shows them in an interactive 3D viewer.',
    tools: [
      tool(
        'generate_image',
        'Generates an image from a text prompt (or edits given input images) and saves it for the user.',
        {
          prompt: z.string().min(1).describe('Detailed description of the desired image'),
          input_image_paths: z
            .array(z.string())
            .max(4)
            .optional()
            .describe('Absolute paths of images to edit or use as reference'),
          aspect_ratio: z.string().optional().describe('e.g. "1:1", "16:9", "9:16"'),
          file_name: z.string().optional().describe('Base file name without extension'),
        },
        async ({ prompt, input_image_paths, aspect_ratio, file_name }) => {
          try {
            const inputImages = (input_image_paths ?? []).map((p) =>
              readInputImage(p, options.readableRoots),
            )
            const config = options.getImageConfig()
            const base = safeOutputName(file_name ?? 'bild', 'bild')
            if (config.backend === 'comfyui') {
              const { files, workflowName } = await comfyGenerateImage(config.comfy, {
                prompt,
                aspectRatio: aspect_ratio,
                inputImages,
              })
              const saved = files.map((f) =>
                write(`${base}${extname(f.filename) || '.png'}`, f.data),
              )
              return textResult(
                [
                  `${saved.length} Datei(en) lokal erzeugt mit ${workflowName} und dem Nutzer angezeigt:`,
                  ...saved.map((f) => `- ${f.path}`),
                ].join('\n'),
              )
            }
            const { images, text } = await generateImages({
              prompt,
              model: config.model,
              apiKey: config.apiKey,
              inputImages: inputImages.map((img) => ({
                mimeType: img.mimeType,
                base64: img.data.toString('base64'),
              })),
              aspectRatio: aspect_ratio,
              ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            })
            const saved = images.map((img) =>
              write(`${base}${EXT_BY_MIME[img.mimeType] ?? '.png'}`, img.data),
            )
            return textResult(
              [
                `${saved.length} Bild(er) erzeugt mit ${config.model} und dem Nutzer angezeigt:`,
                ...saved.map((f) => `- ${f.path}`),
                ...(text ? ['', `Modell-Hinweis: ${text}`] : []),
              ].join('\n'),
            )
          } catch (error) {
            return textResult(error instanceof Error ? error.message : String(error), true)
          }
        },
        { annotations: { openWorldHint: true } },
      ),
      tool(
        'save_file',
        'Saves a file for the user (shown in the app): SVG, HTML, Markdown, CSV, JSON, code, or a ' +
          '3D model as .obj / .stl (ASCII) / .ply (ASCII) / .gltf (JSON).',
        {
          file_name: z.string().min(1).describe('File name with extension, e.g. "haus.obj"'),
          content: z.string().describe('File content (text, or base64 if encoding is "base64")'),
          encoding: z.enum(['utf8', 'base64']).optional(),
        },
        async ({ file_name, content, encoding }) => {
          try {
            const name = safeOutputName(file_name, 'datei.txt')
            const data = encoding === 'base64' ? Buffer.from(content, 'base64') : content
            const file = write(name, data)
            return textResult(
              `Gespeichert und dem Nutzer angezeigt: ${file.path} (${file.size} Bytes)`,
            )
          } catch (error) {
            return textResult(error instanceof Error ? error.message : String(error), true)
          }
        },
      ),
      ...tool3d,
      ...toolOcr,
    ],
  })
}
