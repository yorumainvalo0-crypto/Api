import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { DocumentError } from './errors'
import { truncate } from './markdown'
import { convertOdp, convertPptx } from './presentation'
import { convertDelimited, convertWorkbook } from './spreadsheet'
import type { ConvertedDocument, ExtractedDocument } from './types'
import { convertDoc, convertDocx, convertOdt, convertRtf } from './word'
import { sniff } from './zip'

export { DocumentError } from './errors'
export type { DocumentKind, ExtractedDocument } from './types'

/** Supported office formats (lowercase, with dot). */
export const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.docx',
  '.doc',
  '.odt',
  '.rtf',
  '.xlsx',
  '.xlsm',
  '.xls',
  '.ods',
  '.csv',
  '.tsv',
  '.pptx',
  '.odp',
])

/** Default budget of characters returned to the model (~15k tokens). */
export const DEFAULT_DOCUMENT_MAX_CHARS = 60_000

/** Files above this size are rejected before parsing. */
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024

export function isDocument(fileName: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extname(fileName).toLowerCase())
}

async function convert(extension: string, data: Buffer): Promise<ConvertedDocument> {
  // Word files are often mislabelled (RTF saved as .doc, .docx renamed to .doc, …).
  const container = sniff(data)
  switch (extension) {
    case '.docx':
    case '.doc':
      if (container === 'rtf') return convertRtf(data)
      if (container === 'zip') return convertDocx(data)
      return convertDoc(data)
    case '.odt':
      return convertOdt(data)
    case '.rtf':
      if (container === 'zip') return convertDocx(data)
      if (container === 'cfb') return convertDoc(data)
      return convertRtf(data)
    case '.xlsx':
    case '.xlsm':
      return convertWorkbook(data, 'xlsx')
    case '.xls':
      return convertWorkbook(data, 'xls')
    case '.ods':
      return convertWorkbook(data, 'ods')
    case '.csv':
      return convertDelimited(data, 'csv')
    case '.tsv':
      return convertDelimited(data, 'tsv')
    case '.pptx':
      return convertPptx(data)
    case '.odp':
      return convertOdp(data)
    default:
      throw new DocumentError(
        `Das Dateiformat „${extension || 'ohne Endung'}“ wird nicht unterstützt.`,
      )
  }
}

/**
 * Reads an office document (Word, Excel, PowerPoint, OpenDocument, RTF, CSV) and converts it
 * to Markdown for the model. Throws DocumentError with a German message for unsupported,
 * corrupt or password-protected files.
 */
export async function extractDocument(
  path: string,
  options: { maxChars?: number } = {},
): Promise<ExtractedDocument> {
  const extension = extname(path).toLowerCase()
  if (!DOCUMENT_EXTENSIONS.has(extension)) {
    throw new DocumentError(
      `Das Dateiformat „${extension || 'ohne Endung'}“ wird nicht unterstützt.`,
    )
  }
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) throw new DocumentError(`Datei nicht gefunden: ${path}`)
  if (info.size === 0) throw new DocumentError('Die Datei ist leer.')
  if (info.size > MAX_DOCUMENT_BYTES) {
    throw new DocumentError(
      `Die Datei ist zu groß (${(info.size / 1024 / 1024).toFixed(1)} MB, max. ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB).`,
    )
  }
  const data = await readFile(path)
  const converted = await convert(extension, data)
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_DOCUMENT_MAX_CHARS)
  const { text, truncated } = truncate(converted.markdown, maxChars)
  return { kind: converted.kind, markdown: text, truncated, summary: converted.summary }
}
