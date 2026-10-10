import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import {
  ATTACHMENT_LIMITS,
  type Attachment,
  type AttachmentInput,
  type AttachmentKind,
} from '@shared/schemas/chat'

export class AttachmentError extends Error {
  override name = 'AttachmentError'
}

/** Office formats the app converts to text for the model (see src/main/documents). */
const OFFICE_MIME: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.rtf': 'application/rtf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xls': 'application/vnd.ms-excel',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
}

const MIME_BY_EXT: Record<string, string> = {
  ...OFFICE_MIME,
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'model/obj',
  '.stl': 'model/stl',
  '.ply': 'model/ply',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
}

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.csv',
  '.tsv',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.svg',
  '.log',
  '.env.example',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.swift',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.cs',
  '.php',
  '.lua',
  '.sql',
  '.sh',
  '.bash',
  '.ps1',
  '.bat',
  '.cmd',
  '.r',
  '.dart',
  '.vue',
  '.svelte',
  '.gradle',
  '.dockerfile',
])

/** Image types the Anthropic Messages API accepts as image blocks. */
export const MODEL_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export function detectMime(fileName: string, fallback = 'application/octet-stream'): string {
  return (
    MIME_BY_EXT[extname(fileName).toLowerCase()] ?? (isTextFile(fileName) ? 'text/plain' : fallback)
  )
}

function isTextFile(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  return TEXT_EXTENSIONS.has(extname(lower)) || ['dockerfile', 'makefile', 'readme'].includes(lower)
}

export function classify(fileName: string, mimeType: string): AttachmentKind {
  if (MODEL_IMAGE_TYPES.has(mimeType)) return 'image'
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType.startsWith('model/')) return 'model3d'
  if (
    Object.values(OFFICE_MIME).includes(mimeType) ||
    extname(fileName).toLowerCase() in OFFICE_MIME
  ) {
    return 'document'
  }
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || isTextFile(fileName)) {
    return 'text'
  }
  return 'file'
}

// Characters Windows forbids in file names, plus ASCII control characters.
// eslint-disable-next-line no-control-regex -- control characters are intentionally matched
const UNSAFE_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g

/** Safe single file name: no path parts, no characters Windows forbids. */
export function sanitizeName(name: string): string {
  const cleaned = basename(name).replace(UNSAFE_FILE_CHARS, '_').trim()
  return cleaned.slice(0, 120) || 'datei'
}

function checkSize(kind: AttachmentKind, size: number, name: string): void {
  const limit =
    kind === 'image'
      ? ATTACHMENT_LIMITS.maxImageBytes
      : kind === 'pdf'
        ? ATTACHMENT_LIMITS.maxPdfBytes
        : ATTACHMENT_LIMITS.maxFileBytes
  if (size > limit) {
    throw new AttachmentError(
      `„${name}“ ist zu groß (${(size / 1024 / 1024).toFixed(1)} MB, max. ${limit / 1024 / 1024} MB).`,
    )
  }
}

/** Copies an incoming file into the chat's attachment folder and describes it. */
export function storeAttachment(input: AttachmentInput, attachmentsDir: string): Attachment {
  mkdirSync(attachmentsDir, { recursive: true })
  const id = randomUUID()

  if (input.source === 'path') {
    const stat = statSync(input.path, { throwIfNoEntry: false })
    if (!stat?.isFile()) throw new AttachmentError(`Datei nicht gefunden: ${input.path}`)
    const name = sanitizeName(input.path)
    const mimeType = detectMime(name)
    const kind = classify(name, mimeType)
    checkSize(kind, stat.size, name)
    const target = join(attachmentsDir, `${id}-${name}`)
    copyFileSync(input.path, target)
    return { id, name, mimeType, size: stat.size, kind, path: target }
  }

  const name = sanitizeName(input.name)
  const data = Buffer.from(input.base64, 'base64')
  const mimeType = input.mimeType || detectMime(name)
  const kind = classify(name, mimeType)
  checkSize(kind, data.length, name)
  const target = join(attachmentsDir, `${id}-${name}`)
  writeFileSync(target, data)
  return { id, name, mimeType, size: data.length, kind, path: target }
}

/** Content blocks in the Anthropic Messages API format (subset used for user prompts). */
export type PromptBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: {
        type: 'base64'
        media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
        data: string
      }
    }
  | {
      type: 'document'
      source: { type: 'base64'; media_type: 'application/pdf'; data: string }
      title?: string
    }

export interface PromptCapabilities {
  /** Whether the provider accepts PDF document blocks (Ollama does not). */
  pdf: boolean
}

/** Turns a prompt and its attachments into model content blocks. */
export function buildPromptBlocks(
  prompt: string,
  attachments: Attachment[],
  capabilities: PromptCapabilities,
): PromptBlock[] {
  const blocks: PromptBlock[] = []
  const notes: string[] = []

  for (const a of attachments) {
    if (a.kind === 'image' && MODEL_IMAGE_TYPES.has(a.mimeType)) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: a.mimeType as 'image/png',
          data: readFileSync(a.path).toString('base64'),
        },
      })
    } else if (a.kind === 'pdf' && capabilities.pdf) {
      blocks.push({
        type: 'document',
        title: a.name,
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: readFileSync(a.path).toString('base64'),
        },
      })
    } else if (a.kind === 'text' && a.size <= ATTACHMENT_LIMITS.maxInlineTextBytes) {
      const content = readFileSync(a.path, 'utf8')
      blocks.push({ type: 'text', text: `<file name="${a.name}">\n${content}\n</file>` })
    } else {
      notes.push(`- ${a.name} (${a.mimeType}, ${a.size} Bytes): ${a.path}`)
    }
  }

  const text = notes.length
    ? `${prompt}\n\nAngehängte Dateien (im Dateisystem abgelegt):\n${notes.join('\n')}`
    : prompt
  blocks.push({ type: 'text', text })
  return blocks
}
