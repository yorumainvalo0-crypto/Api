import mammoth from 'mammoth'
import TurndownService from 'turndown'
import WordExtractor from 'word-extractor'
import * as XLSX from 'xlsx'
import { DocumentError, PASSWORD_MESSAGE, corruptMessage, toDocumentError } from './errors'
import {
  countWords,
  formatCount,
  normalizeListMarkers,
  tabsToTables,
  tableCell,
  tidyMarkdown,
} from './markdown'
import {
  createOdfContext,
  footnoteSection,
  isEncryptedOdf,
  odfBlocks,
  officeBody,
} from './opendocument'
import { rtfToText } from './rtf'
import type { ConvertedDocument } from './types'
import { isEncryptedOoxml, openPackage, sniff, type Package } from './zip'
import { findFirst } from './xml'

const WORD_LABEL = 'Word-Dokument'

// Sentinels used to rebuild tables from Turndown's bottom-up conversion.
const CELL_START = '\uE001'
const CELL_END = '\uE002'
const ROW_START = '\uE003'
const ROW_END = '\uE004'

function createTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  })
  service.remove(['script', 'style'])
  service.addRule('image', {
    filter: 'img',
    replacement: (_content, node) => {
      const alt = (node as unknown as { getAttribute(name: string): string | null })
        .getAttribute('alt')
        ?.trim()
      return alt ? `[Bild: ${alt}]` : '[Bild]'
    },
  })
  service.addRule('tableCell', {
    filter: ['td', 'th'],
    replacement: (content) => `${CELL_START}${content.replace(/\s*\n\s*/g, ' ').trim()}${CELL_END}`,
  })
  service.addRule('tableRow', {
    filter: 'tr',
    replacement: (content) => `${ROW_START}${content}${ROW_END}`,
  })
  service.addRule('table', {
    filter: 'table',
    replacement: (content) => {
      const rows: string[][] = []
      for (const row of content.matchAll(/\uE003([\s\S]*?)\uE004/g)) {
        const cells = [...(row[1] ?? '').matchAll(/\uE001([\s\S]*?)\uE002/g)].map((c) =>
          tableCell(c[1] ?? ''),
        )
        if (cells.length) rows.push(cells)
      }
      if (!rows.length) return ''
      const width = Math.max(...rows.map((r) => r.length))
      const line = (cells: string[]): string =>
        `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`
      // Header cells are usually bold; the table header row already implies that.
      const [header = [], ...body] = rows
      for (let i = 0; i < header.length; i++) {
        header[i] = (header[i] ?? '').replace(/^\*\*(.+)\*\*$/, '$1')
      }
      const separator = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`
      return `\n\n${[line(header), separator, ...body.map(line)].join('\n')}\n\n`
    },
  })
  // Code blocks from the "Code Block" style map arrive as <pre> without <code>.
  service.addRule('preformatted', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const text = (node as unknown as { textContent: string | null }).textContent ?? ''
      const fence = text.includes('```') ? '~~~' : '```'
      return `\n\n${fence}\n${text.replace(/\n$/, '')}\n${fence}\n\n`
    },
  })
  // mammoth wraps table header rows in <thead>; keep them transparent.
  service.addRule('tableSection', {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement: (content) => content,
  })
  return service
}

let turndown: TurndownService | undefined

/** Extra mammoth style mappings for common Word style names (code, quotes). */
const STYLE_MAP = [
  "p[style-name='Code Block'] => pre:separator('\\n')",
  "p[style-name='HTML Preformatted'] => pre:separator('\\n')",
  "p[style-name='Source Code'] => pre:separator('\\n')",
  "r[style-name='Code'] => code",
  "r[style-name='HTML Code'] => code",
  "r[style-name='Verbatim Char'] => code",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  "p[style-name='Zitat'] => blockquote > p:fresh",
]

/** Turndown pads list markers ("-   item"); a single space reads better. */
function compactLists(markdown: string): string {
  return markdown.replace(/^(\s*)([-*+]|\d+\.)\s{2,}(?=\S)/gm, '$1$2 ')
}

function wordSummary(markdown: string, pages: number | undefined, suffix = ''): string {
  const words = countWords(markdown)
  const rounded =
    words < 100 ? words : words < 1000 ? Math.round(words / 10) * 10 : Math.round(words / 100) * 100
  const parts = [
    pages ? `${formatCount(pages)} ${pages === 1 ? 'Seite' : 'Seiten'}` : undefined,
    `≈${formatCount(rounded)} Wörter`,
  ].filter(Boolean)
  return `Word-Dokument${suffix}, ${parts.join('/')}`
}

function pageCountFromAppXml(pkg: Package): number | undefined {
  const xml = pkg.text('docProps/app.xml')
  const m = xml ? /<Pages>(\d+)<\/Pages>/.exec(xml) : null
  const pages = m ? Number(m[1]) : 0
  return pages > 0 ? pages : undefined
}

export async function convertDocx(data: Buffer): Promise<ConvertedDocument> {
  const pkg = openPackage(data, WORD_LABEL, (p) => p === 'docProps/app.xml')
  if (!pkg.has('word/document.xml')) throw new DocumentError(corruptMessage(WORD_LABEL))
  let html: string
  try {
    const result = await mammoth.convertToHtml(
      { buffer: data },
      {
        convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })),
        styleMap: STYLE_MAP,
        externalFileAccess: false,
      },
    )
    html = result.value
  } catch (error) {
    throw toDocumentError(error, WORD_LABEL)
  }
  turndown ??= createTurndown()
  const markdown = tidyMarkdown(compactLists(turndown.turndown(html || '<p></p>')))
  return { kind: 'word', markdown, summary: wordSummary(markdown, pageCountFromAppXml(pkg)) }
}

/** Legacy binary Word (.doc, Word 97–2003). */
export async function convertDoc(data: Buffer): Promise<ConvertedDocument> {
  if (isEncryptedOoxml(data) || isEncryptedDoc(data)) throw new DocumentError(PASSWORD_MESSAGE)
  let text: string
  try {
    const doc = await new WordExtractor().extract(data)
    const parts = [doc.getBody()]
    const footnotes = doc.getFootnotes().trim()
    if (footnotes) parts.push(`## Fußnoten\n\n${footnotes}`)
    const endnotes = doc.getEndnotes().trim()
    if (endnotes) parts.push(`## Endnoten\n\n${endnotes}`)
    text = parts.join('\n\n')
  } catch (error) {
    throw toDocumentError(error, WORD_LABEL)
  }
  const markdown = tidyMarkdown(tabsToTables(normalizeListMarkers(text)))
  return { kind: 'word', markdown, summary: wordSummary(markdown, undefined, ' (.doc)') }
}

/** Reads the fEncrypted flag from the FIB of a legacy Word file. */
function isEncryptedDoc(data: Buffer): boolean {
  if (sniff(data) !== 'cfb') return false
  try {
    const cfb = XLSX.CFB.read(data, { type: 'buffer' }) as unknown
    const entry = XLSX.CFB.find(cfb, 'WordDocument') as { content?: Uint8Array } | null
    const content = entry?.content
    if (!content || content.length < 12) return false
    const flags = (content[10] ?? 0) | ((content[11] ?? 0) << 8)
    return (flags & 0x0100) !== 0
  } catch {
    return false
  }
}

export function convertOdt(data: Buffer): ConvertedDocument {
  const label = 'OpenDocument-Text'
  const pkg = openPackage(data, label)
  if (isEncryptedOdf(pkg)) throw new DocumentError(PASSWORD_MESSAGE)
  let markdown: string
  try {
    const content = pkg.xml('content.xml')
    const body = content && officeBody(content, 'office:text')
    if (!content || !body) throw new DocumentError(corruptMessage(label))
    const ctx = createOdfContext(pkg, content)
    markdown = tidyMarkdown(
      [odfBlocks(body, ctx).join('\n\n'), footnoteSection(ctx)].filter(Boolean).join('\n\n'),
    )
  } catch (error) {
    throw toDocumentError(error, label)
  }
  let pages: number | undefined
  const meta = pkg.xml('meta.xml')
  const stats = meta && findFirst(meta, 'meta:document-statistic')
  if (stats) pages = Number(stats.attrs['meta:page-count'] ?? '0') || undefined
  return {
    kind: 'word',
    markdown,
    summary: wordSummary(markdown, pages).replace('Word-Dokument', 'OpenDocument-Text'),
  }
}

export function convertRtf(data: Buffer): ConvertedDocument {
  if (sniff(data) !== 'rtf') throw new DocumentError(corruptMessage('RTF-Dokument'))
  const markdown = tidyMarkdown(normalizeListMarkers(rtfToText(data.toString('latin1'))))
  return {
    kind: 'word',
    markdown,
    summary: wordSummary(markdown, undefined).replace('Word-Dokument', 'RTF-Dokument'),
  }
}
