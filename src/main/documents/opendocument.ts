import { markdownTable, unwrapBold } from './markdown'
import { type Package } from './zip'
import { child, elements, type XmlElement, type XmlNode } from './xml'

/** Formatting resolved from OpenDocument styles (automatic styles + named styles). */
interface OdfStyles {
  bold: Set<string>
  italic: Set<string>
  /** Paragraph style → heading level (Title → 1, Heading N → N). */
  headings: Map<string, number>
  /** List style → per-level "numbered" flag. */
  numberedLists: Map<string, boolean[]>
}

export interface OdfContext {
  styles: OdfStyles
  footnotes: string[]
}

function collectStyles(roots: (XmlElement | undefined)[]): OdfStyles {
  const styles: OdfStyles = {
    bold: new Set(),
    italic: new Set(),
    headings: new Map(),
    numberedLists: new Map(),
  }
  const parents = new Map<string, string>()
  const visit = (node: XmlElement): void => {
    for (const el of elements(node)) {
      if (el.name === 'style:style') {
        const name = el.attrs['style:name']
        if (!name) continue
        const parent = el.attrs['style:parent-style-name']
        if (parent) parents.set(name, parent)
        const props = child(el, 'style:text-properties')
        if (props?.attrs['fo:font-weight'] === 'bold') styles.bold.add(name)
        if (props?.attrs['fo:font-style'] === 'italic') styles.italic.add(name)
        const level = headingLevel(name, el.attrs['style:default-outline-level'])
        if (level) styles.headings.set(name, level)
      } else if (el.name === 'text:list-style') {
        const name = el.attrs['style:name']
        if (!name) continue
        const levels: boolean[] = []
        for (const level of elements(el)) {
          const index = Number(level.attrs['text:level'] ?? '1') - 1
          if (index >= 0 && index < 10)
            levels[index] = level.name === 'text:list-level-style-number'
        }
        styles.numberedLists.set(name, levels)
      } else {
        visit(el)
      }
    }
  }
  for (const root of roots) if (root) visit(root)

  // Resolve inheritance (automatic styles usually derive from named ones).
  for (const [name] of parents) {
    let current: string | undefined = name
    for (let depth = 0; current && depth < 10; depth++) {
      if (styles.bold.has(current)) styles.bold.add(name)
      if (styles.italic.has(current)) styles.italic.add(name)
      const level = styles.headings.get(current) ?? headingLevel(current, undefined)
      if (level && !styles.headings.has(name)) styles.headings.set(name, level)
      current = parents.get(current)
    }
  }
  return styles
}

function headingLevel(styleName: string, outlineLevel: string | undefined): number | undefined {
  if (outlineLevel && Number(outlineLevel) > 0) return Math.min(6, Number(outlineLevel))
  if (/^Title$/i.test(styleName)) return 1
  if (/^Subtitle$/i.test(styleName)) return 2
  const m = /^Heading(?:_20_|\s)?(\d)$/i.exec(styleName)
  return m ? Math.min(6, Number(m[1])) : undefined
}

export function createOdfContext(pkg: Package, content: XmlElement): OdfContext {
  return {
    styles: collectStyles([child(content, 'office:automatic-styles'), pkg.xml('styles.xml')]),
    footnotes: [],
  }
}

/** Throws if the package is an encrypted (password-protected) OpenDocument file. */
export function isEncryptedOdf(pkg: Package): boolean {
  return pkg.text('META-INF/manifest.xml')?.includes('encryption-data') ?? false
}

const wrap = (text: string, marker: string): string => {
  const m = /^(\s*)(.*?)(\s*)$/s.exec(text)
  if (!m || !m[2]) return text
  return `${m[1]}${marker}${m[2]}${marker}${m[3]}`
}

/** Inline text of a paragraph-level element with bold/italic/link Markdown. */
export function odfInline(node: XmlElement, ctx: OdfContext): string {
  let out = ''
  for (const c of node.children) out += inlineNode(c, ctx)
  return out
}

function inlineNode(node: XmlNode, ctx: OdfContext): string {
  if (typeof node === 'string') return node.replace(/\s+/g, ' ')
  switch (node.name) {
    case 'text:s':
      return ' '.repeat(Math.min(50, Number(node.attrs['text:c'] ?? '1') || 1))
    case 'text:tab':
      return '\t'
    case 'text:line-break':
      return '\n'
    case 'text:span': {
      const style = node.attrs['text:style-name'] ?? ''
      let text = odfInline(node, ctx)
      if (ctx.styles.italic.has(style)) text = wrap(text, '*')
      if (ctx.styles.bold.has(style)) text = wrap(text, '**')
      return text
    }
    case 'text:a': {
      const text = odfInline(node, ctx)
      const href = node.attrs['xlink:href']
      return href && text.trim() && !href.startsWith('#') ? `[${text}](${href})` : text
    }
    case 'text:note': {
      const body = child(node, 'text:note-body')
      if (!body) return ''
      ctx.footnotes.push(odfBlocks(body, ctx).join(' ').trim())
      return `[^${ctx.footnotes.length}]`
    }
    case 'draw:frame': {
      const textBox = child(node, 'draw:text-box')
      if (textBox) return ` ${odfBlocks(textBox, ctx).join(' ')} `
      if (child(node, 'draw:image')) return imageLabel(node)
      if (child(node, 'draw:object')) return '[Objekt]'
      return ''
    }
    case 'draw:image':
      return '[Bild]'
    case 'office:annotation':
    case 'office:annotation-end':
    case 'text:bookmark':
    case 'text:bookmark-start':
    case 'text:bookmark-end':
    case 'text:soft-page-break':
    case 'text:reference-mark-start':
    case 'text:reference-mark-end':
    case 'text:change':
    case 'text:change-start':
    case 'text:change-end':
      return ''
    default:
      return odfInline(node, ctx)
  }
}

function imageLabel(frame: XmlElement): string {
  const title = textOfChild(frame, 'svg:title') || textOfChild(frame, 'svg:desc')
  return title ? `[Bild: ${title}]` : '[Bild]'
}

function textOfChild(node: XmlElement, name: string): string {
  const c = child(node, name)
  return c
    ? c.children
        .filter((x): x is string => typeof x === 'string')
        .join('')
        .trim()
    : ''
}

/** Markdown blocks of a container element (office:text, table cell, text box, note body). */
export function odfBlocks(node: XmlElement, ctx: OdfContext): string[] {
  const out: string[] = []
  for (const el of elements(node)) {
    switch (el.name) {
      case 'text:h': {
        const style = el.attrs['text:style-name'] ?? ''
        const level = Math.min(
          6,
          Math.max(
            1,
            Number(el.attrs['text:outline-level'] ?? ctx.styles.headings.get(style) ?? 1),
          ),
        )
        const text = odfInline(el, ctx).trim()
        if (text) out.push(`${'#'.repeat(level)} ${text.replace(/\n/g, ' ')}`)
        break
      }
      case 'text:p': {
        const style = el.attrs['text:style-name'] ?? ''
        const text = odfInline(el, ctx).trim()
        if (!text) break
        const level = ctx.styles.headings.get(style)
        out.push(level ? `${'#'.repeat(level)} ${text.replace(/\n/g, ' ')}` : text)
        break
      }
      case 'text:list':
        out.push(odfList(el, ctx, 0, el.attrs['text:style-name']))
        break
      case 'table:table':
        out.push(odfTable(el, ctx))
        break
      case 'text:table-of-content':
      case 'text:alphabetical-index':
      case 'text:illustration-index':
      case 'text:table-index':
      case 'text:bibliography':
      case 'text:user-index': {
        const body = child(el, 'text:index-body')
        if (body) out.push(...odfBlocks(body, ctx))
        break
      }
      case 'text:tracked-changes':
      case 'text:sequence-decls':
      case 'text:variable-decls':
      case 'text:user-field-decls':
      case 'office:forms':
      case 'office:annotation':
        break
      default:
        out.push(...odfBlocks(el, ctx))
    }
  }
  return out.filter((b) => b.trim())
}

function odfList(
  list: XmlElement,
  ctx: OdfContext,
  depth: number,
  inheritedStyle: string | undefined,
): string {
  const styleName = list.attrs['text:style-name'] ?? inheritedStyle
  const numbered = (styleName && ctx.styles.numberedLists.get(styleName)?.[depth]) ?? false
  const indent = '  '.repeat(depth)
  const lines: string[] = []
  let counter = 0
  for (const item of elements(list)) {
    if (item.name !== 'text:list-item' && item.name !== 'text:list-header') continue
    const isHeader = item.name === 'text:list-header'
    let first = true
    for (const part of elements(item)) {
      if (part.name === 'text:list') {
        lines.push(odfList(part, ctx, depth + 1, styleName))
        continue
      }
      const text = odfBlocks({ name: '#item', attrs: {}, children: [part] }, ctx)
        .join(' ')
        .replace(/^#+\s*/, '')
        .replace(/\n/g, ' ')
        .trim()
      if (!text) continue
      if (first && !isHeader) {
        counter++
        lines.push(`${indent}${numbered ? `${counter}.` : '-'} ${text}`)
      } else {
        lines.push(`${indent}  ${text}`)
      }
      first = false
    }
  }
  return lines.join('\n')
}

const MAX_TABLE_COLUMNS = 40

export function odfTable(table: XmlElement, ctx: OdfContext): string {
  const rows: string[][] = []
  const collectRows = (node: XmlElement): void => {
    for (const el of elements(node)) {
      if (el.name === 'table:table-row') {
        const cells: string[] = []
        for (const cell of elements(el)) {
          if (cell.name !== 'table:table-cell' && cell.name !== 'table:covered-table-cell') continue
          const text = odfBlocks(cell, ctx).join('\n')
          const repeat = Math.min(
            Number(cell.attrs['table:number-columns-repeated'] ?? '1') || 1,
            50,
          )
          for (let i = 0; i < repeat && cells.length < MAX_TABLE_COLUMNS; i++) cells.push(text)
        }
        while (cells.length && !cells[cells.length - 1]?.trim()) cells.pop()
        if (cells.length) rows.push(cells)
      } else if (
        el.name === 'table:table-header-rows' ||
        el.name === 'table:table-rows' ||
        el.name === 'table:table-row-group'
      ) {
        collectRows(el)
      }
    }
  }
  collectRows(table)
  const [header, ...body] = rows
  if (!header) return ''
  return markdownTable(header.map(unwrapBold), body)
}

/** Footnotes collected while rendering, as a Markdown section. */
export function footnoteSection(ctx: OdfContext): string {
  if (!ctx.footnotes.length) return ''
  return ctx.footnotes.map((text, i) => `[^${i + 1}]: ${text}`).join('\n')
}

export function officeBody(content: XmlElement, kind: string): XmlElement | undefined {
  return child(child(content, 'office:body'), kind)
}
