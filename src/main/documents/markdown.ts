/** Shared Markdown helpers for the document converters. */

export const TRUNCATION_MARKER = '[… gekürzt]'

/** Escapes a value for use inside a GFM table cell (single line, no pipes). */
export function tableCell(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim().replace(/\|/g, '\\|').replace(/\n+/g, '<br>')
}

/** Renders a GFM pipe table. Rows are padded to the widest row. */
export function markdownTable(header: string[], rows: string[][]): string {
  const width = Math.max(header.length, ...rows.map((r) => r.length), 1)
  const pad = (row: string[]): string[] =>
    Array.from({ length: width }, (_, i) => tableCell(row[i] ?? ''))
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`
  return [
    line(pad(header)),
    line(Array.from({ length: width }, () => '---')),
    ...rows.map((r) => line(pad(r))),
  ].join('\n')
}

/** Removes bold markers wrapping a whole cell or title (headers are bold anyway). */
export function unwrapBold(text: string): string {
  return text.replace(/^\*\*([^*]+)\*\*$/, '$1')
}

/**
 * Turns runs of tab-separated lines (as produced by plain-text Word extraction) into
 * Markdown tables (needs at least two consecutive lines with the same number of tabs); every
 * other line becomes its own paragraph.
 */
export function tabsToTables(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const tabs = (lines[i]?.match(/\t/g) ?? []).length
    let j = i
    if (tabs > 0) {
      while (j + 1 < lines.length && (lines[j + 1]?.match(/\t/g) ?? []).length === tabs) j++
    }
    if (tabs > 0 && j > i) {
      const rows = lines.slice(i, j + 1).map((line) => line.split('\t'))
      // Word's cell marks often leave a trailing tab on every row.
      while (rows.every((r) => r.length > 1 && r[r.length - 1] === '')) {
        for (const r of rows) r.pop()
      }
      const [header = [], ...body] = rows
      out.push('', markdownTable(header, body), '')
      i = j + 1
    } else {
      // Plain-text extraction yields one line per paragraph.
      out.push(lines[i] ?? '', '')
      i++
    }
  }
  return out.join('\n')
}

/** Normalises list markers from plain-text extraction ("•\tItem", "1.\tItem"). */
export function normalizeListMarkers(text: string): string {
  return text
    .replace(/^[ \t]*(?:[•·▪◦][ \t]+|[o§-]\t+)(?=\S)/gm, (m) =>
      /^\s*[◦o]/.test(m) ? '  - ' : '- ',
    )
    .replace(/^[ \t]*(\d{1,3}[.)])\t+(?=\S)/gm, '$1 ')
}

/** Collapses excess blank lines and trailing whitespace. */
export function tidyMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function truncate(markdown: string, maxChars: number): { text: string; truncated: boolean } {
  if (markdown.length <= maxChars) return { text: markdown, truncated: false }
  let cut = markdown.slice(0, maxChars)
  // Prefer to cut at a line break so tables and paragraphs stay intact.
  const lastBreak = cut.lastIndexOf('\n')
  if (lastBreak > maxChars * 0.8) cut = cut.slice(0, lastBreak)
  return { text: `${cut.trimEnd()}\n\n${TRUNCATION_MARKER}`, truncated: true }
}

const numberFormat = new Intl.NumberFormat('de-DE')

export function formatCount(n: number): string {
  return numberFormat.format(n)
}

/** Word count of Markdown text, ignoring table/format syntax. */
export function countWords(markdown: string): number {
  const plain = markdown.replace(/[|#*_`>[\]()-]+/g, ' ')
  return plain.match(/[\p{L}\p{N}][\p{L}\p{N}'’.,-]*/gu)?.length ?? 0
}

/** Spreadsheet-style column name: 0 → A, 26 → AA. */
export function columnName(index: number): string {
  let n = index + 1
  let name = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    name = String.fromCharCode(65 + rem) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}
