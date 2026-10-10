import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ILevelsOptions,
  type ParagraphChild,
} from 'docx'
import PptxGenJS from 'pptxgenjs'
import * as XLSX from 'xlsx'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { z } from 'zod'
import { DocumentError } from './errors'
import {
  MAX_LIST_LEVEL,
  parseInline,
  parseMarkdown,
  type Alignment,
  type Block,
  type InlineRun,
} from './markdown-parse'

// --- Schemas ----------------------------------------------------------------------

export const MAX_SHEETS = 50
export const MAX_CELLS = 100_000
export const MAX_SLIDES = 200

export const WordInputSchema = z.object({
  markdown: z
    .string()
    .max(1_000_000)
    .describe(
      'Document content as Markdown: # headings, **bold**, *italic*, `code`, lists (nested), ' +
        'GFM pipe tables, ``` code blocks, > quotes, --- rules.',
    ),
  title: z.string().max(300).optional().describe('Document title (stored in the properties).'),
})

const CellSchema = z.union([z.string().max(32_767), z.number(), z.boolean(), z.null()])

export const SpreadsheetInputSchema = z
  .object({
    sheets: z
      .array(
        z.object({
          name: z.string().max(200).describe('Sheet name (shortened to 31 characters).'),
          rows: z
            .array(z.array(CellSchema).max(16_384))
            .max(1_048_576)
            .describe(
              'Rows of cells. Strings starting with "=" become formulas in English Excel ' +
                'syntax (e.g. "=SUM(B2:B9)"); prefix with an apostrophe for literal text.',
            ),
          header: z.boolean().optional().describe('First row is a header (default true).'),
        }),
      )
      .min(1)
      .max(MAX_SHEETS),
  })
  .superRefine((input, ctx) => {
    const cells = input.sheets.reduce(
      (sum, sheet) => sum + sheet.rows.reduce((n, row) => n + row.length, 0),
      0,
    )
    if (cells > MAX_CELLS) {
      ctx.addIssue({
        code: 'custom',
        message: `Too many cells (${cells}, max. ${MAX_CELLS}).`,
        path: ['sheets'],
      })
    }
  })

export const PresentationInputSchema = z
  .object({
    title: z.string().max(300).optional().describe('Adds a title slide when set.'),
    slides: z
      .array(
        z.object({
          title: z.string().max(300),
          bullets: z
            .array(z.string().max(2_000))
            .max(30)
            .optional()
            .describe('Bullet points; indent with two spaces per level for sub-points.'),
          notes: z.string().max(20_000).optional().describe('Speaker notes.'),
          imagePath: z
            .string()
            .min(1)
            .max(1_000)
            .optional()
            .describe('Absolute path of a local PNG, JPEG or GIF image.'),
        }),
      )
      .max(MAX_SLIDES),
  })
  .refine((input) => input.slides.length > 0 || Boolean(input.title), {
    message: 'At least one slide or a title is required.',
    path: ['slides'],
  })

export type WordInput = z.input<typeof WordInputSchema>
export type SpreadsheetInput = z.input<typeof SpreadsheetInputSchema>
export type PresentationInput = z.input<typeof PresentationInputSchema>

function validate<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new DocumentError(`Ungültige Eingabe: ${z.prettifyError(result.error)}`)
  }
  return result.data
}

// --- Word -------------------------------------------------------------------------

const FONT = 'Calibri'
const CODE_FONT = 'Consolas'
const ACCENT = '2F5496'
/** Usable width of an A4 page with 2.5 cm margins, in twips. */
const CONTENT_WIDTH = 9_638
const PAGE_MARGIN = 1_134

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const

const BULLET_SYMBOLS = ['•', '◦', '▪']
const NUMBER_FORMATS = [
  { format: LevelFormat.DECIMAL, text: (l: number) => `%${l + 1}.` },
  { format: LevelFormat.LOWER_LETTER, text: (l: number) => `%${l + 1})` },
  { format: LevelFormat.LOWER_ROMAN, text: (l: number) => `%${l + 1}.` },
]

function listLevels(ordered: boolean): ILevelsOptions[] {
  return Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, level) => {
    const numbering = NUMBER_FORMATS[level] ?? NUMBER_FORMATS[0]
    return {
      level,
      format: ordered ? (numbering?.format ?? LevelFormat.DECIMAL) : LevelFormat.BULLET,
      text: ordered ? (numbering?.text(level) ?? '%1.') : (BULLET_SYMBOLS[level] ?? '•'),
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
    }
  })
}

function textRuns(runs: InlineRun[], base: { bold?: boolean } = {}): ParagraphChild[] {
  return runs.map((run) => {
    const textRun = new TextRun({
      text: run.text,
      bold: Boolean(run.bold || base.bold),
      italics: Boolean(run.italic),
      strike: Boolean(run.strike),
      ...(run.lineBreak ? { break: 1 } : {}),
      ...(run.code ? { style: 'CodeChar' } : run.link ? { style: 'Hyperlink' } : {}),
    })
    return run.link ? new ExternalHyperlink({ link: run.link, children: [textRun] }) : textRun
  })
}

const CODE_SHADING = { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' } as const

const ALIGNMENTS: Record<
  NonNullable<Alignment>,
  (typeof AlignmentType)[keyof typeof AlignmentType]
> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
}

function wordTable(block: Extract<Block, { type: 'table' }>): Table {
  const columns = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1)
  const width = Math.floor(CONTENT_WIDTH / columns)
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' }
  const cell = (text: string, column: number, header: boolean): TableCell => {
    const align = block.align[column]
    return new TableCell({
      width: { size: width, type: WidthType.DXA },
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      ...(header ? { shading: { type: ShadingType.CLEAR, fill: 'D9E2F3', color: 'auto' } } : {}),
      children: [
        new Paragraph({
          spacing: { before: 0, after: 0 },
          ...(align ? { alignment: ALIGNMENTS[align] } : {}),
          children: textRuns(parseInline(text), { bold: header }),
        }),
      ],
    })
  }
  const row = (cells: string[], header: boolean): TableRow =>
    new TableRow({
      tableHeader: header,
      children: Array.from({ length: columns }, (_, i) => cell(cells[i] ?? '', i, header)),
    })
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: Array.from({ length: columns }, () => width),
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border,
    },
    rows: [row(block.header, true), ...block.rows.map((r) => row(r, false))],
  })
}

function wordBlocks(blocks: Block[]): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = []
  let listInstance = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        out.push(
          new Paragraph({
            heading: HEADING_LEVELS[block.level - 1] ?? HeadingLevel.HEADING_6,
            children: textRuns(parseInline(block.text)),
          }),
        )
        break
      case 'paragraph':
        out.push(new Paragraph({ children: textRuns(parseInline(block.text)) }))
        break
      case 'list':
        // Only numbered lists need their own instance (to restart at 1); docx gets slow with
        // many instances, so bullet lists share one.
        if (block.items.some((item) => item.ordered)) listInstance++
        for (const item of block.items) {
          out.push(
            new Paragraph({
              numbering: {
                reference: item.ordered ? 'numbered' : 'bullets',
                level: item.level,
                instance: item.ordered ? listInstance : 0,
              },
              spacing: { after: 60 },
              children: textRuns(parseInline(item.text)),
            }),
          )
        }
        break
      case 'code':
        // One paragraph per line; readers (and mammoth) merge them via the style.
        for (const [index, line] of (block.lines.length ? block.lines : ['']).entries()) {
          const first = index === 0
          const last = index === Math.max(block.lines.length, 1) - 1
          out.push(
            new Paragraph({
              style: 'CodeBlock',
              ...(first || last
                ? { spacing: { before: first ? 120 : 0, after: last ? 120 : 0, line: 240 } }
                : {}),
              children: [new TextRun({ text: line.replace(/\t/g, '    ') })],
            }),
          )
        }
        break
      case 'table':
        out.push(wordTable(block))
        out.push(new Paragraph({ spacing: { after: 0 }, children: [] }))
        break
      case 'quote':
        out.push(
          new Paragraph({
            indent: { left: 567 },
            border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'BFBFBF', space: 8 } },
            children: textRuns(parseInline(block.text)),
            style: 'Quote',
          }),
        )
        break
      case 'hr':
        out.push(
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BFBFBF', space: 1 } },
            children: [],
          }),
        )
        break
    }
  }
  return out
}

const headingStyle = (size: number, color: string, extra: { italics?: boolean } = {}) => ({
  run: { font: FONT, size, bold: true, color, ...extra },
  paragraph: { spacing: { before: 240, after: 120 }, keepNext: true, keepLines: true },
})

/** Creates a .docx from Markdown. Returns the file content. */
export async function createWordDocument(input: WordInput): Promise<Buffer> {
  const { markdown, title } = validate(WordInputSchema, input)
  const children = wordBlocks(parseMarkdown(markdown))
  const doc = new Document({
    creator: 'AI Workbench',
    ...(title ? { title } : {}),
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 22 },
          paragraph: { spacing: { after: 120, line: 276 } },
        },
        heading1: headingStyle(32, '1F3864'),
        heading2: headingStyle(26, ACCENT),
        heading3: headingStyle(24, '1F3763'),
        heading4: headingStyle(22, ACCENT, { italics: true }),
        heading5: headingStyle(22, ACCENT),
        heading6: headingStyle(22, '1F3763', { italics: true }),
      },
      paragraphStyles: [
        {
          id: 'Quote',
          name: 'Quote',
          basedOn: 'Normal',
          next: 'Normal',
          run: { italics: true, color: '595959' },
        },
        {
          id: 'CodeBlock',
          name: 'Code Block',
          basedOn: 'Normal',
          next: 'Normal',
          run: { font: CODE_FONT, size: 20 },
          paragraph: { spacing: { before: 0, after: 0, line: 240 }, shading: CODE_SHADING },
        },
      ],
      characterStyles: [
        {
          id: 'CodeChar',
          name: 'Code',
          basedOn: 'DefaultParagraphFont',
          run: { font: CODE_FONT, size: 20, shading: CODE_SHADING },
        },
      ],
    },
    numbering: {
      config: [
        { reference: 'bullets', levels: listLevels(false) },
        { reference: 'numbered', levels: listLevels(true) },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: PAGE_MARGIN,
              bottom: PAGE_MARGIN,
              left: PAGE_MARGIN,
              right: PAGE_MARGIN,
            },
          },
        },
        children: children.length ? children : [new Paragraph({ children: [] })],
      },
    ],
  })
  return Packer.toBuffer(doc)
}

// --- Spreadsheet ------------------------------------------------------------------

const INVALID_SHEET_CHARS = /[[\]:*?/\\]/g

/** Makes sheet names valid for Excel: ≤ 31 chars, no []:*?/\, not empty, unique. */
export function sanitizeSheetNames(names: string[]): string[] {
  const used = new Set<string>()
  return names.map((raw, index) => {
    let name = raw
      .replace(INVALID_SHEET_CHARS, '_')
      // eslint-disable-next-line no-control-regex -- control characters are intentionally removed
      .replace(/[\u0000-\u001f]/g, '')
      .trim()
      .replace(/^'+|'+$/g, '')
      .slice(0, 31)
      .trim()
    if (!name || name.toLowerCase() === 'history') name = name ? `${name}_` : `Tabelle${index + 1}`
    let candidate = name
    for (let n = 2; used.has(candidate.toLowerCase()); n++) {
      const suffix = ` (${n})`
      candidate = `${name.slice(0, 31 - suffix.length).trimEnd()}${suffix}`
    }
    used.add(candidate.toLowerCase())
    return candidate
  })
}

type CellValue = string | number | boolean | null

function toCell(value: CellValue): XLSX.CellObject | undefined {
  if (value === null) return undefined
  if (typeof value === 'number') return { t: 'n', v: value }
  if (typeof value === 'boolean') return { t: 'b', v: value }
  if (value.length > 1 && value.startsWith('='))
    return { t: 'z', f: value.slice(1) } as XLSX.CellObject
  if (value.startsWith("'=")) return { t: 's', v: value.slice(1) }
  return { t: 's', v: value }
}

function displayWidth(value: CellValue): number {
  if (value === null) return 0
  if (typeof value === 'string' && value.startsWith('=')) return 10
  return String(value)
    .split('\n')
    .reduce((max, line) => Math.max(max, line.length), 0)
}

/** Creates an .xlsx workbook. Returns the file content. */
export function createSpreadsheet(input: SpreadsheetInput): Buffer {
  const { sheets } = validate(SpreadsheetInputSchema, input)
  const names = sanitizeSheetNames(sheets.map((s) => s.name))
  const workbook = XLSX.utils.book_new()
  const headerSheets: boolean[] = []
  let hasFormulas = false

  sheets.forEach((sheet, index) => {
    const worksheet: XLSX.WorkSheet = {}
    let maxColumn = 0
    const widths: number[] = []
    sheet.rows.forEach((row, r) => {
      row.forEach((value, c) => {
        const cell = toCell(value)
        if (!cell) return
        if (cell.f) hasFormulas = true
        worksheet[XLSX.utils.encode_cell({ r, c })] = cell
        maxColumn = Math.max(maxColumn, c)
        widths[c] = Math.max(widths[c] ?? 0, displayWidth(value))
      })
    })
    const rowCount = Math.max(sheet.rows.length, 1)
    worksheet['!ref'] = XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: rowCount - 1, c: maxColumn },
    })
    worksheet['!cols'] = Array.from({ length: maxColumn + 1 }, (_, c) => ({
      wch: Math.min(60, Math.max(8, (widths[c] ?? 0) + 2)),
    }))
    const header = (sheet.header ?? true) && sheet.rows.length > 0
    if (header && sheet.rows.length > 1) {
      worksheet['!autofilter'] = { ref: worksheet['!ref'] }
    }
    headerSheets.push(header)
    XLSX.utils.book_append_sheet(workbook, worksheet, names[index])
  })

  const written = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true })
  return styleWorkbook(written as Buffer, headerSheets, hasFormulas)
}

/**
 * SheetJS Community cannot write cell styles or frozen panes, so the generated package is
 * patched: a bold font for header rows, a frozen first row, and recalculation on open for
 * formulas (which are written without cached values).
 */
function styleWorkbook(data: Buffer, headerSheets: boolean[], hasFormulas: boolean): Buffer {
  const files = unzipSync(data)
  const patch = (path: string, fn: (xml: string) => string): void => {
    const entry = files[path]
    if (entry) files[path] = strToU8(fn(strFromU8(entry)))
  }

  let boldStyle: number | undefined
  if (headerSheets.some(Boolean)) {
    patch('xl/styles.xml', (xml) => {
      const fonts = /<fonts count="(\d+)"[^>]*>([\s\S]*?)<\/fonts>/.exec(xml)
      const xfs = /<cellXfs count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)
      if (!fonts || !xfs) return xml
      const fontCount = Number(fonts[1])
      const xfCount = Number(xfs[1])
      const firstFont = /<font>([\s\S]*?)<\/font>/.exec(fonts[2] ?? '')?.[1] ?? '<sz val="11"/>'
      boldStyle = xfCount
      return xml
        .replace(
          fonts[0],
          `<fonts count="${fontCount + 1}">${fonts[2]}<font><b/>${firstFont}</font></fonts>`,
        )
        .replace(
          xfs[0],
          `<cellXfs count="${xfCount + 1}">${xfs[2]}<xf numFmtId="0" fontId="${fontCount}" ` +
            `fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>`,
        )
    })
  }

  headerSheets.forEach((header, index) => {
    if (!header) return
    patch(`xl/worksheets/sheet${index + 1}.xml`, (xml) => {
      let out = xml.replace(
        /<sheetView workbookViewId="0"\/>/,
        '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" ' +
          'state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>',
      )
      if (boldStyle !== undefined) {
        out = out.replace(
          /<row r="1"([^>]*)>([\s\S]*?)<\/row>/,
          (_row, attrs: string, cells: string) => {
            const styled = cells.replace(
              /<c r="([A-Z]+1)"(?![^>]*\ss=)/g,
              `<c r="$1" s="${boldStyle}"`,
            )
            return `<row r="1"${attrs}>${styled}</row>`
          },
        )
      }
      return out
    })
  })

  if (hasFormulas) {
    patch('xl/workbook.xml', (xml) =>
      xml.includes('<calcPr')
        ? xml
        : xml.replace('</workbook>', '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>'),
    )
  }
  return Buffer.from(zipSync(files, { level: 6 }))
}

// --- Presentation -----------------------------------------------------------------

const SLIDE_W = 13.333
const SLIDE_H = 7.5
const TEXT_COLOR = '1F2937'
const MUTED_COLOR = '6B7280'
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

interface ImageInfo {
  name: string
  data: string
  width: number
  height: number
}

/** Reads width/height from PNG, JPEG or GIF headers. */
export function imageDimensions(data: Buffer): { width: number; height: number; mime: string } {
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), mime: 'image/png' }
  }
  if (data.length > 10 && data.toString('latin1', 0, 3) === 'GIF') {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8), mime: 'image/gif' }
  }
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset++
        continue
      }
      const marker = data[offset + 1] ?? 0
      const length = data.readUInt16BE(offset + 2)
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          height: data.readUInt16BE(offset + 5),
          width: data.readUInt16BE(offset + 7),
          mime: 'image/jpeg',
        }
      }
      offset += 2 + length
    }
  }
  throw new DocumentError('Das Bild hat kein unterstütztes Format (PNG, JPEG oder GIF).')
}

async function loadImage(path: string): Promise<ImageInfo> {
  if (!isAbsolute(path)) throw new DocumentError(`Der Bildpfad muss absolut sein: ${path}`)
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) throw new DocumentError(`Bild nicht gefunden: ${path}`)
  if (info.size > MAX_IMAGE_BYTES) {
    throw new DocumentError(
      `Das Bild ist zu groß (max. ${MAX_IMAGE_BYTES / 1024 / 1024} MB): ${path}`,
    )
  }
  if (!['.png', '.jpg', '.jpeg', '.gif'].includes(extname(path).toLowerCase())) {
    throw new DocumentError(`Das Bild hat kein unterstütztes Format (PNG, JPEG oder GIF): ${path}`)
  }
  const data = await readFile(path)
  const { width, height, mime } = imageDimensions(data)
  if (!width || !height) throw new DocumentError(`Das Bild ist beschädigt: ${path}`)
  return { name: basename(path), data: `${mime};base64,${data.toString('base64')}`, width, height }
}

/** Fits an image into a box, keeping its aspect ratio and centring it. */
function fitImage(
  image: ImageInfo,
  box: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(box.w / image.width, box.h / image.height)
  const w = image.width * scale
  const h = image.height * scale
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h }
}

function bulletRuns(bullets: string[]): PptxGenJS.TextProps[] {
  return bullets
    .filter((b) => b.trim())
    .map((bullet, i, all) => {
      const indent = /^(\s*)/.exec(bullet)?.[1]?.replace(/\t/g, '  ').length ?? 0
      const text = bullet.trim().replace(/^[-*•]\s+/, '')
      return {
        text,
        options: {
          bullet: true,
          indentLevel: Math.min(3, Math.floor(indent / 2)),
          breakLine: i < all.length - 1,
        },
      }
    })
}

function definePresentationMasters(pptx: PptxGenJS): void {
  const accentBar: PptxGenJS.SlideMasterProps['objects'] = [
    { rect: { x: 0, y: 0, w: SLIDE_W, h: 0.12, fill: { color: ACCENT } } },
  ]
  pptx.defineSlideMaster({
    title: 'AIW_TITLE',
    background: { color: 'FFFFFF' },
    objects: [
      { rect: { x: 0, y: SLIDE_H - 0.5, w: SLIDE_W, h: 0.5, fill: { color: ACCENT } } },
      {
        placeholder: {
          options: {
            name: 'title',
            type: 'title',
            x: 0.8,
            y: 2.3,
            w: SLIDE_W - 1.6,
            h: 2,
            fontFace: FONT,
            fontSize: 40,
            bold: true,
            color: TEXT_COLOR,
            align: 'center',
            valign: 'middle',
          },
          text: '',
        },
      },
    ],
  })
  const title = {
    placeholder: {
      options: {
        name: 'title',
        type: 'title' as const,
        x: 0.6,
        y: 0.35,
        w: SLIDE_W - 1.2,
        h: 1,
        fontFace: FONT,
        fontSize: 30,
        bold: true,
        color: TEXT_COLOR,
        align: 'left' as const,
        valign: 'middle' as const,
      },
      text: '',
    },
  }
  const body = (w: number) => ({
    placeholder: {
      options: {
        name: 'body',
        type: 'body' as const,
        x: 0.6,
        y: 1.55,
        w,
        h: SLIDE_H - 2.3,
        fontFace: FONT,
        fontSize: 20,
        color: TEXT_COLOR,
        valign: 'top' as const,
      },
      text: '',
    },
  })
  const slideNumber = {
    x: SLIDE_W - 1.1,
    y: SLIDE_H - 0.5,
    w: 0.8,
    h: 0.35,
    fontSize: 10,
    color: MUTED_COLOR,
  }
  pptx.defineSlideMaster({
    title: 'AIW_CONTENT',
    background: { color: 'FFFFFF' },
    objects: [...(accentBar ?? []), title, body(SLIDE_W - 1.2)],
    slideNumber,
  })
  pptx.defineSlideMaster({
    title: 'AIW_CONTENT_IMAGE',
    background: { color: 'FFFFFF' },
    objects: [...(accentBar ?? []), title, body(SLIDE_W / 2 - 0.8)],
    slideNumber,
  })
}

/** Creates a 16:9 .pptx presentation. Returns the file content. */
export async function createPresentation(input: PresentationInput): Promise<Buffer> {
  const { title, slides } = validate(PresentationInputSchema, input)
  const images = await Promise.all(
    slides.map((s) => (s.imagePath ? loadImage(s.imagePath) : Promise.resolve(undefined))),
  )

  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'AI Workbench'
  if (title) pptx.title = title
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT }
  definePresentationMasters(pptx)

  if (title) {
    pptx.addSlide({ masterName: 'AIW_TITLE' }).addText(title, { placeholder: 'title' })
  }

  slides.forEach((input, index) => {
    const image = images[index]
    const bullets = bulletRuns(input.bullets ?? [])
    const slide = pptx.addSlide({
      masterName: image && bullets.length ? 'AIW_CONTENT_IMAGE' : 'AIW_CONTENT',
    })
    slide.addText(input.title, { placeholder: 'title' })
    if (bullets.length) slide.addText(bullets, { placeholder: 'body' })
    if (image) {
      const box = bullets.length
        ? { x: SLIDE_W / 2 + 0.2, y: 1.55, w: SLIDE_W / 2 - 0.8, h: SLIDE_H - 2.3 }
        : { x: 0.6, y: 1.55, w: SLIDE_W - 1.2, h: SLIDE_H - 2.3 }
      slide.addImage({ data: image.data, altText: image.name, ...fitImage(image, box) })
    }
    if (input.notes?.trim()) slide.addNotes(input.notes)
  })

  const output = await pptx.write({ outputType: 'nodebuffer', compression: true })
  return Buffer.isBuffer(output) ? output : Buffer.from(output as ArrayBuffer)
}
