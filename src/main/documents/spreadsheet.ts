import * as XLSX from 'xlsx'
import * as cptable from 'xlsx/dist/cpexcel.full.mjs'
import { DocumentError, PASSWORD_MESSAGE, corruptMessage, toDocumentError } from './errors'
import { columnName, formatCount, markdownTable, tidyMarkdown } from './markdown'
import type { ConvertedDocument } from './types'
import { isEncryptedOdf } from './opendocument'
import { isEncryptedOoxml, openPackage, sniff } from './zip'

const isManifest = (path: string): boolean => path === 'META-INF/manifest.xml'

// Code pages for legacy .xls files and non-UTF-8 text.
XLSX.set_cptable(cptable)

export const MAX_SHEET_ROWS = 500
export const MAX_SHEET_COLUMNS = 40
const MAX_CELL_CHARS = 500
const MAX_SUMMARY_SHEETS = 5

interface Cell {
  t: string
  v?: unknown
  w?: string
  f?: string
  z?: string | number
}

type SpreadsheetFormat = 'xlsx' | 'xls' | 'ods' | 'csv' | 'tsv'

const LABELS: Record<SpreadsheetFormat, string> = {
  xlsx: 'Excel',
  xls: 'Excel',
  ods: 'OpenDocument-Tabelle',
  csv: 'CSV',
  tsv: 'TSV',
}

function pad(n: number, length = 2): string {
  return String(n).padStart(length, '0')
}

/** Excel serial date → ISO date (time only if present); timezone independent. */
function formatSerialDate(serial: number, date1904: boolean): string | undefined {
  const parsed = XLSX.SSF.parse_date_code(serial, { date1904 }) as
    { y: number; m: number; d: number; H: number; M: number; S: number } | undefined
  if (!parsed) return undefined
  const time = parsed.H || parsed.M || parsed.S
  const timeText = `${pad(parsed.H)}:${pad(parsed.M)}${parsed.S ? `:${pad(parsed.S)}` : ''}`
  if (serial < 1 && serial >= 0) return timeText
  const date = `${pad(parsed.y, 4)}-${pad(parsed.m)}-${pad(parsed.d)}`
  return time ? `${date} ${timeText}` : date
}

function cellText(cell: Cell | undefined, date1904: boolean): string {
  if (!cell) return ''
  let value: string
  if (
    cell.t === 'n' &&
    typeof cell.v === 'number' &&
    cell.z !== undefined &&
    isDateFormat(cell.z)
  ) {
    value = formatSerialDate(cell.v, date1904) ?? cell.w ?? String(cell.v)
  } else if (cell.t === 'd' && cell.v instanceof Date) {
    value = cell.v
      .toISOString()
      .replace('T00:00:00.000Z', '')
      .replace(/:00\.000Z$|\.000Z$/, '')
  } else if (cell.t === 'z') {
    value = ''
  } else {
    value = cell.w ?? (cell.v === undefined || cell.v === null ? '' : String(cell.v))
  }
  value = value.trim()
  if (cell.f) value = value ? `=${cell.f} → ${value}` : `=${cell.f}`
  return value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}…` : value
}

function isDateFormat(format: string | number): boolean {
  try {
    return XLSX.SSF.is_date(format) as boolean
  } catch {
    return false
  }
}

interface SheetRender {
  markdown: string
  rows: number
  columns: number
}

function renderSheet(
  sheet: XLSX.WorkSheet,
  date1904: boolean,
  options: { rowNumbers: boolean },
): SheetRender {
  const ref = sheet['!ref']
  if (!ref) return { markdown: '*(leer)*', rows: 0, columns: 0 }
  const range = XLSX.utils.decode_range(ref)
  const fullRef = (sheet['!fullref'] as string | undefined) ?? ref
  const full = XLSX.utils.decode_range(fullRef)

  // Collect rendered cells and the used area.
  const grid: { row: number; cells: string[] }[] = []
  let maxCol = -1
  const lastCol = Math.min(range.e.c, range.s.c + MAX_SHEET_COLUMNS - 1)
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cells: string[] = []
    let any = false
    for (let c = range.s.c; c <= lastCol; c++) {
      const text = cellText(sheet[XLSX.utils.encode_cell({ r, c })] as Cell | undefined, date1904)
      cells.push(text)
      if (text) {
        any = true
        maxCol = Math.max(maxCol, c)
      }
    }
    if (any) grid.push({ row: r, cells })
  }
  if (!grid.length) return { markdown: '*(leer)*', rows: 0, columns: 0 }

  // Columns beyond the cap that hold data (only the rows that were read).
  let hiddenColumns = 0
  if (range.e.c > lastCol) {
    for (const address of Object.keys(sheet)) {
      if (address.startsWith('!')) continue
      const cell = sheet[address] as Cell
      if (cell.t === 'z' && !cell.f) continue
      const { c } = XLSX.utils.decode_cell(address)
      if (c > lastCol) hiddenColumns = Math.max(hiddenColumns, c - lastCol)
    }
  }

  const width = maxCol - range.s.c + 1
  for (const row of grid) row.cells.length = width

  const first = grid[0]
  const looksLikeHeader =
    grid.length > 1 &&
    first !== undefined &&
    first.cells.filter(Boolean).length >= Math.max(1, Math.ceil(width / 2)) &&
    first.cells.every((text, i) => {
      if (!text) return true
      const cell = sheet[XLSX.utils.encode_cell({ r: first.row, c: range.s.c + i })] as
        Cell | undefined
      return cell?.t === 's' && !cell.f && !/^-?[\d.,]+%?$/.test(text)
    })

  const letters = Array.from({ length: width }, (_, i) => columnName(range.s.c + i))
  const header = looksLikeHeader ? first.cells.map((text, i) => text || letters[i] || '') : letters
  const bodyRows = (looksLikeHeader ? grid.slice(1) : grid).slice(0, MAX_SHEET_ROWS)
  const withNumbers = (cells: string[], row: number | string): string[] =>
    options.rowNumbers ? [String(row), ...cells] : cells

  const table = markdownTable(
    withNumbers(header, '#'),
    bodyRows.map((r) => withNumbers(r.cells, r.row + 1)),
  )
  const notes: string[] = []
  const shownLastRow = bodyRows[bodyRows.length - 1]?.row ?? range.s.r
  const omittedRows = full.e.r - shownLastRow
  if (omittedRows > 0) {
    notes.push(`… ${formatCount(omittedRows)} weitere Zeilen ausgelassen`)
  }
  if (hiddenColumns > 0) {
    notes.push(`… ${formatCount(hiddenColumns)} weitere Spalten ausgelassen`)
  }
  return {
    // The note goes first so it survives truncation of long tables.
    markdown: notes.length ? `*${notes.join('; ')}*\n\n${table}` : table,
    rows: full.e.r - range.s.r + 1,
    columns: (hiddenColumns > 0 ? lastCol + hiddenColumns : maxCol) - range.s.c + 1,
  }
}

function readOptions(): XLSX.ParsingOptions {
  return {
    type: 'buffer',
    cellFormula: true,
    cellNF: true,
    cellText: true,
    cellDates: false,
    cellHTML: false,
    sheetStubs: true,
    bookVBA: false,
    // +1 for a header row, a little slack for leading blank rows.
    sheetRows: MAX_SHEET_ROWS + 20,
  }
}

export function convertWorkbook(data: Buffer, format: 'xlsx' | 'xls' | 'ods'): ConvertedDocument {
  const label = format === 'ods' ? 'OpenDocument-Tabellendokument' : 'Excel-Dokument'
  if (isEncryptedOoxml(data)) throw new DocumentError(PASSWORD_MESSAGE)
  const container = sniff(data)
  if ((format === 'xlsx' || format === 'ods') && container !== 'zip' && container !== 'cfb') {
    throw new DocumentError(corruptMessage(label))
  }
  if (container === 'zip' && isEncryptedOdf(openPackage(data, label, isManifest))) {
    throw new DocumentError(PASSWORD_MESSAGE)
  }
  let workbook: XLSX.WorkBook
  try {
    workbook = XLSX.read(data, readOptions())
  } catch (error) {
    throw toDocumentError(error, label)
  }
  if (!workbook.SheetNames.length) throw new DocumentError(corruptMessage(label))
  return renderWorkbook(workbook, LABELS[format], true)
}

function renderWorkbook(
  workbook: XLSX.WorkBook,
  label: string,
  rowNumbers: boolean,
): ConvertedDocument {
  const date1904 = Boolean(workbook.Workbook?.WBProps?.date1904)
  const sections: string[] = []
  const dims: string[] = []
  workbook.SheetNames.forEach((name, index) => {
    const sheet = workbook.Sheets[name]
    if (!sheet) return
    const hidden = workbook.Workbook?.Sheets?.[index]?.Hidden
    const rendered = renderSheet(sheet, date1904, { rowNumbers })
    sections.push(`## ${name}${hidden ? ' (ausgeblendet)' : ''}\n\n${rendered.markdown}`)
    dims.push(`${name}: ${formatCount(rendered.rows)}×${formatCount(rendered.columns)}`)
  })
  const count = workbook.SheetNames.length
  const listed =
    dims.slice(0, MAX_SUMMARY_SHEETS).join(', ') + (dims.length > MAX_SUMMARY_SHEETS ? ', …' : '')
  return {
    kind: 'spreadsheet',
    markdown: tidyMarkdown(sections.join('\n\n')),
    summary: `${label}, ${count} ${count === 1 ? 'Tabellenblatt' : 'Tabellenblätter'} (${listed})`,
  }
}

/** Decodes CSV bytes: BOM-aware UTF-8/UTF-16, falling back to Windows-1252. */
export function decodeText(data: Uint8Array): string {
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(data.subarray(3))
  }
  if (data[0] === 0xff && data[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(data.subarray(2))
  if (data[0] === 0xfe && data[1] === 0xff)
    return new TextDecoder('utf-16be').decode(data.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    return new TextDecoder('windows-1252').decode(data)
  }
}

const DELIMITERS = [';', ',', '\t', '|'] as const

/** Picks the delimiter that splits the first lines most consistently (quotes respected). */
export function detectDelimiter(text: string): string {
  const lines = splitLogicalLines(text.slice(0, 64 * 1024))
    .slice(0, 20)
    .filter((l) => l.trim())
  let best: string = ','
  let bestScore = 0
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter))
    const first = counts[0] ?? 0
    if (first === 0) continue
    const consistent = counts.filter((c) => c === first).length
    const score = consistent * 1000 + first
    if (score > bestScore) {
      bestScore = score
      best = delimiter
    }
  }
  return best
}

function splitLogicalLines(text: string): string[] {
  const lines: string[] = []
  let current = ''
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    if ((ch === '\n' || ch === '\r') && !quoted) {
      if (current) lines.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current) lines.push(current)
  return lines
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0
  let quoted = false
  for (const ch of line) {
    if (ch === '"') quoted = !quoted
    else if (ch === delimiter && !quoted) count++
  }
  return count
}

/** Minimal RFC 4180 parser, used when SheetJS cannot make sense of the text. */
function parseCsv(text: string, delimiter: string, maxRows: number): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field || row.length) rows.push([...row, field])
  return rows
}

export function convertDelimited(data: Buffer, format: 'csv' | 'tsv'): ConvertedDocument {
  const text = decodeText(data).replace(/^\uFEFF/, '')
  const delimiter = format === 'tsv' ? '\t' : detectDelimiter(text)
  let workbook: XLSX.WorkBook | undefined
  try {
    workbook = XLSX.read(text, {
      type: 'string',
      FS: delimiter,
      raw: true,
      dense: false,
      sheetRows: MAX_SHEET_ROWS + 20,
    })
    if (!workbook.SheetNames.length || !workbook.Sheets[workbook.SheetNames[0] ?? '']) {
      workbook = undefined
    }
  } catch {
    workbook = undefined
  }
  if (!workbook) {
    const sheet = XLSX.utils.aoa_to_sheet(parseCsv(text, delimiter, MAX_SHEET_ROWS + 20))
    workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, sheet, 'Tabelle1')
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? '']
  if (!sheet) throw new DocumentError(corruptMessage('CSV-Dokument'))
  // Total row count: SheetJS stops at sheetRows, so count lines for the summary.
  const totalLines = splitLogicalLines(text).length
  if (sheet['!ref'] && totalLines > MAX_SHEET_ROWS + 20) {
    const range = XLSX.utils.decode_range(sheet['!ref'])
    range.e.r = Math.max(range.e.r, totalLines - 1)
    sheet['!fullref'] = XLSX.utils.encode_range(range)
  }
  const rendered = renderSheet(sheet, false, { rowNumbers: false })
  const delimiterName = delimiter === '\t' ? 'Tab' : `„${delimiter}“`
  return {
    kind: 'spreadsheet',
    markdown: rendered.markdown,
    summary: `${LABELS[format]}, ${formatCount(rendered.rows)}×${formatCount(rendered.columns)} (Trennzeichen ${delimiterName})`,
  }
}
