/**
 * Parser for the Markdown subset used to create Word documents: ATX headings, paragraphs,
 * bullet/numbered lists (nested), GFM pipe tables, fenced code blocks, block quotes,
 * horizontal rules and inline bold/italic/strike/code/links.
 */

export interface InlineStyle {
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
  link?: string
}

export interface InlineRun extends InlineStyle {
  text: string
  /** Hard line break before this run. */
  lineBreak?: boolean
}

export type Alignment = 'left' | 'center' | 'right' | undefined

export interface ListItem {
  level: number
  ordered: boolean
  text: string
}

export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: ListItem[] }
  | { type: 'code'; lines: string[] }
  | { type: 'table'; header: string[]; align: Alignment[]; rows: string[][] }
  | { type: 'quote'; text: string }
  | { type: 'hr' }

export const MAX_LIST_LEVEL = 2

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const HEADING = /^\s{0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?$/
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function indentWidth(spaces: string): number {
  return spaces.replace(/\t/g, '    ').length
}

export function splitTableRow(line: string): string[] {
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|'
      i++
    } else if (ch === '|') {
      cells.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  cells.push(current.trim())
  return cells
}

function isTableStart(lines: string[], i: number): boolean {
  const line = lines[i] ?? ''
  const next = lines[i + 1] ?? ''
  return line.includes('|') && TABLE_SEPARATOR.test(next) && next.includes('-')
}

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (!paragraph.length) return
    // Two trailing spaces or a backslash mark a hard line break.
    const text = paragraph
      .map((l, idx) => {
        const last = idx === paragraph.length - 1
        const hard = /( {2,}|\\)$/.test(l)
        const content = l.trim().replace(/\\$/, '')
        return last ? content : `${content}${hard ? '\n' : ' '}`
      })
      .join('')
    blocks.push({ type: 'paragraph', text })
    paragraph = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''

    const fence = FENCE.exec(line)
    if (fence) {
      flushParagraph()
      const marker = fence[1] ?? '```'
      const code: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith(marker)) {
        code.push(lines[i] ?? '')
        i++
      }
      i++ // closing fence
      blocks.push({ type: 'code', lines: code })
      continue
    }

    if (!line.trim()) {
      flushParagraph()
      i++
      continue
    }

    const heading = HEADING.exec(line.trimEnd())
    if (heading) {
      flushParagraph()
      blocks.push({ type: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' })
      i++
      continue
    }

    if (HR.test(line)) {
      flushParagraph()
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    if (isTableStart(lines, i)) {
      flushParagraph()
      const header = splitTableRow(line)
      const align: Alignment[] = splitTableRow(lines[i + 1] ?? '').map((spec) => {
        const left = spec.startsWith(':')
        const right = spec.endsWith(':')
        return left && right ? 'center' : right ? 'right' : left ? 'left' : undefined
      })
      const rows: string[][] = []
      i += 2
      while (i < lines.length && (lines[i] ?? '').trim() && (lines[i] ?? '').includes('|')) {
        rows.push(splitTableRow(lines[i] ?? ''))
        i++
      }
      blocks.push({ type: 'table', header, align, rows })
      continue
    }

    if (LIST_ITEM.test(line)) {
      flushParagraph()
      const items: ListItem[] = []
      const indents: number[] = []
      while (i < lines.length) {
        const current = lines[i] ?? ''
        const item = LIST_ITEM.exec(current)
        if (item) {
          const indent = indentWidth(item[1] ?? '')
          const ordered = /\d/.test(item[2] ?? '')
          // A top-level item of the other kind (bullet vs. numbered) starts a new list.
          const first = items[0]
          if (first && ordered !== first.ordered && indent <= (indents[0] ?? 0)) break
          while (indents.length && indent < (indents[indents.length - 1] ?? 0)) indents.pop()
          if (!indents.length || indent > (indents[indents.length - 1] ?? 0)) indents.push(indent)
          items.push({
            level: Math.min(MAX_LIST_LEVEL, indents.length - 1),
            ordered,
            text: item[3] ?? '',
          })
          i++
          continue
        }
        if (!current.trim()) {
          // A blank line continues the list only if another item follows.
          let j = i + 1
          while (j < lines.length && !(lines[j] ?? '').trim()) j++
          if (j < lines.length && LIST_ITEM.test(lines[j] ?? '')) {
            i = j
            continue
          }
          break
        }
        // Continuation line (indented or lazy) belongs to the previous item.
        const last = items[items.length - 1]
        if (
          !last ||
          HEADING.test(current.trimEnd()) ||
          FENCE.test(current) ||
          QUOTE.test(current) ||
          HR.test(current) ||
          isTableStart(lines, i)
        ) {
          break
        }
        last.text += ` ${current.trim()}`
        i++
      }
      blocks.push({ type: 'list', items })
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote) {
      flushParagraph()
      const quoted: string[] = []
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i] ?? '')
        if (!m) break
        quoted.push(m[1] ?? '')
        i++
      }
      blocks.push({ type: 'quote', text: quoted.join('\n').trim() })
      continue
    }

    paragraph.push(line)
    i++
  }
  flushParagraph()
  return blocks
}

// --- Inline -------------------------------------------------------------------

// Escaped characters are swapped for private-use code points while parsing.
const ESCAPABLE = /\\([\\`*_{}[\]()#+\-.!|~<>])/g
const PRIVATE_BASE = 0xe000

function protectEscapes(text: string): string {
  return text.replace(ESCAPABLE, (_, ch: string) =>
    String.fromCharCode(PRIVATE_BASE + ch.charCodeAt(0)),
  )
}

function restoreEscapes(text: string): string {
  return text.replace(/[\uE000-\uE0FF]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - PRIVATE_BASE),
  )
}

interface InlinePattern {
  regex: RegExp
  apply: (m: RegExpExecArray, style: InlineStyle) => InlineRun[]
}

const SAFE_LINK = /^(https?:|mailto:)/i

const PATTERNS: InlinePattern[] = [
  {
    regex: /(`+)([\s\S]*?[^`])\1(?!`)/g,
    apply: (m, style) => [{ ...style, code: true, text: restoreEscapes(m[2] ?? '').trim() }],
  },
  {
    regex: /!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g,
    apply: (m, style) => [{ ...style, text: m[1] ? `[Bild: ${m[1]}]` : '[Bild]' }],
  },
  {
    regex: /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    apply: (m, style) => {
      const href = restoreEscapes(m[2] ?? '')
      return parseInlineRuns(m[1] ?? '', SAFE_LINK.test(href) ? { ...style, link: href } : style)
    },
  },
  {
    regex: /<((?:https?:\/\/|mailto:)[^>\s]+)>/g,
    apply: (m, style) => [{ ...style, link: m[1] ?? '', text: m[1] ?? '' }],
  },
  {
    regex: /\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g,
    apply: (m, style) => parseInlineRuns(m[1] ?? '', { ...style, bold: true, italic: true }),
  },
  {
    // Bold whose content may contain complete *italic* spans: **a *b***.
    regex: /\*\*(?=\S)((?:[^*]|\*[^*\s][^*]*\*)+?)\*\*/g,
    apply: (m, style) => parseInlineRuns(m[1] ?? '', { ...style, bold: true }),
  },
  {
    regex: /\*\*(?=\S)([\s\S]*?\S)\*\*/g,
    apply: (m, style) => parseInlineRuns(m[1] ?? '', { ...style, bold: true }),
  },
  {
    regex: /(?<![\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/gu,
    apply: (m, style) => parseInlineRuns(m[1] ?? '', { ...style, bold: true }),
  },
  {
    regex: /\*(?=[^\s*])([\s\S]*?[^\s*])\*/g,
    apply: (m, style) => parseInlineRuns(m[1] ?? '', { ...style, italic: true }),
  },
  {
    regex: /(?<![\p{L}\p{N}_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}_])/gu,
    apply: (m, style) => parseInlineRuns(m[1] ?? '', { ...style, italic: true }),
  },
  {
    regex: /~~(?=\S)([\s\S]*?\S)~~/g,
    apply: (m, style) => parseInlineRuns(m[1] ?? '', { ...style, strike: true }),
  },
]

function parseInlineRuns(text: string, style: InlineStyle): InlineRun[] {
  const runs: InlineRun[] = []
  const pushText = (value: string): void => {
    if (!value) return
    // Hard line breaks inside paragraphs ("\n") become separate runs.
    value.split('\n').forEach((part, idx) => {
      const run: InlineRun = { ...style, text: restoreEscapes(part) }
      if (idx > 0) run.lineBreak = true
      if (run.text || run.lineBreak) runs.push(run)
    })
  }
  // Next match per pattern from the current position; null once a pattern has no more matches.
  // Caching keeps the scan roughly linear for long paragraphs with many spans.
  const next: (RegExpExecArray | null | undefined)[] = PATTERNS.map(() => undefined)
  let pos = 0
  while (pos < text.length) {
    let best: { match: RegExpExecArray; pattern: InlinePattern } | undefined
    PATTERNS.forEach((pattern, i) => {
      let match = next[i]
      if (match === undefined || (match && match.index < pos)) {
        pattern.regex.lastIndex = pos
        match = pattern.regex.exec(text)
        next[i] = match
      }
      if (match && (!best || match.index < best.match.index)) best = { match, pattern }
    })
    if (!best) break
    const { match, pattern } = best
    pushText(text.slice(pos, match.index))
    runs.push(...pattern.apply(match, style))
    pos = match.index + match[0].length
  }
  pushText(text.slice(pos))
  return runs
}

/** Parses inline Markdown into styled runs. */
export function parseInline(text: string): InlineRun[] {
  return parseInlineRuns(protectEscapes(text), {})
}
