import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { OutputFile } from '@shared/schemas/media'
import { classify, detectMime, MODEL_IMAGE_TYPES, sanitizeName } from '../workspace/attachments'
import { isAllowedPath } from './outputs'
import { generateImages } from './image-generation'

export const MEDIA_MCP_SERVER = 'media'
export const MEDIA_TOOL_NAMES = [
  `mcp__${MEDIA_MCP_SERVER}__generate_image`,
  `mcp__${MEDIA_MCP_SERVER}__save_file`,
]

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

export interface MediaServerOptions {
  /** Folder that receives generated files. */
  outputsDir: string
  /** Folders input images may be read from (chat attachments, project). */
  readableRoots: string[]
  getImageConfig: () => { apiKey: string | undefined; model: string }
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
            const inputImages = (input_image_paths ?? []).map((path) => {
              if (!isAllowedPath(path, options.readableRoots)) {
                throw new Error(`Eingabebild außerhalb der erlaubten Ordner: ${path}`)
              }
              const mimeType = detectMime(path)
              if (!MODEL_IMAGE_TYPES.has(mimeType))
                throw new Error(`Kein unterstütztes Bild: ${path}`)
              return { mimeType, base64: readFileSync(path).toString('base64') }
            })
            const { model, apiKey } = options.getImageConfig()
            const { images, text } = await generateImages({
              prompt,
              model,
              apiKey,
              inputImages,
              aspectRatio: aspect_ratio,
              ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            })
            const base = safeOutputName(file_name ?? 'bild', 'bild')
            const saved = images.map((img) =>
              write(`${base}${EXT_BY_MIME[img.mimeType] ?? '.png'}`, img.data),
            )
            return textResult(
              [
                `${saved.length} Bild(er) erzeugt mit ${model} und dem Nutzer angezeigt:`,
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
    ],
  })
}
