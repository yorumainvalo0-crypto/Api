import { extname } from 'node:path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { OutputFile } from '@shared/schemas/media'
import { isAllowedPath } from '../media/outputs'
import {
  createPresentation,
  createSpreadsheet,
  createWordDocument,
  PresentationInputSchema,
  SpreadsheetInputSchema,
  WordInputSchema,
} from './create'
import { extractDocument } from './extract'

export const DOCUMENT_TOOL_NAMES = [
  'read_document',
  'create_word_document',
  'create_spreadsheet',
  'create_presentation',
] as const

export interface DocumentToolOptions {
  /** Folders documents and slide images may be read from. */
  readableRoots: string[]
  /** Stores a generated file in the outputs folder and shows it to the user. */
  write: (fileName: string, data: Buffer) => OutputFile
  /** Turns a model-supplied name into a safe file name. */
  safeName: (name: string, fallback: string) => string
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) }
}

function errorResult(error: unknown) {
  return textResult(error instanceof Error ? error.message : String(error), true)
}

/** Forces the expected extension, e.g. "bericht" or "bericht.txt" → "bericht.docx". */
export function withExtension(name: string, extension: string): string {
  const current = extname(name)
  const stem = current ? name.slice(0, -current.length) : name
  return `${stem || 'dokument'}${extension}`
}

function saved(file: OutputFile): string {
  return `Gespeichert und dem Nutzer angezeigt: ${file.path} (${file.size} Bytes)`
}

const fileNameField = z
  .string()
  .min(1)
  .max(200)
  .describe('File name; the extension is added automatically')

/** Agent tools to read and create Word, Excel and PowerPoint files (pure JS, works offline). */
export function createDocumentTools(options: DocumentToolOptions) {
  const output = (name: string, extension: string) =>
    withExtension(options.safeName(name, `dokument${extension}`), extension)

  return [
    tool(
      'read_document',
      'Reads an office document (Word .docx/.doc/.odt/.rtf, Excel .xlsx/.xls/.ods/.csv, ' +
        'PowerPoint .pptx/.odp) and returns its content as Markdown (tables stay tables).',
      {
        path: z.string().describe('Absolute path of the document (attachment or project file)'),
        max_chars: z
          .number()
          .int()
          .min(1_000)
          .max(400_000)
          .optional()
          .describe('Character budget (default 60000)'),
      },
      async ({ path, max_chars }) => {
        try {
          if (!isAllowedPath(path, options.readableRoots)) {
            throw new Error(`Datei außerhalb der erlaubten Ordner: ${path}`)
          }
          const doc = await extractDocument(path, max_chars ? { maxChars: max_chars } : {})
          return textResult(
            `${doc.summary}${doc.truncated ? ' (gekürzt)' : ''}\n\n${doc.markdown || '[leer]'}`,
          )
        } catch (error) {
          return errorResult(error)
        }
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'create_word_document',
      'Creates a Word document (.docx) from Markdown and shows it to the user.',
      { file_name: fileNameField, ...WordInputSchema.shape },
      async ({ file_name, ...input }) => {
        try {
          return textResult(
            saved(options.write(output(file_name, '.docx'), await createWordDocument(input))),
          )
        } catch (error) {
          return errorResult(error)
        }
      },
    ),
    tool(
      'create_spreadsheet',
      'Creates an Excel workbook (.xlsx) with one or more sheets and shows it to the user. ' +
        'Numbers stay numbers; formulas like "=SUM(B2:B9)" are supported.',
      { file_name: fileNameField, ...SpreadsheetInputSchema.shape },
      async ({ file_name, ...input }) => {
        try {
          return textResult(
            saved(options.write(output(file_name, '.xlsx'), createSpreadsheet(input))),
          )
        } catch (error) {
          return errorResult(error)
        }
      },
    ),
    tool(
      'create_presentation',
      'Creates a PowerPoint presentation (.pptx) with title, bullet points, speaker notes and ' +
        'optional images, and shows it to the user.',
      { file_name: fileNameField, ...PresentationInputSchema.shape },
      async ({ file_name, ...input }) => {
        try {
          for (const slide of input.slides) {
            if (slide.imagePath && !isAllowedPath(slide.imagePath, options.readableRoots)) {
              throw new Error(`Bild außerhalb der erlaubten Ordner: ${slide.imagePath}`)
            }
          }
          return textResult(
            saved(options.write(output(file_name, '.pptx'), await createPresentation(input))),
          )
        } catch (error) {
          return errorResult(error)
        }
      },
    ),
  ]
}
