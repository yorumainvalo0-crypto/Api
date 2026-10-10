/**
 * Tiny, dependency-free XML reader for the well-formed XML inside office packages
 * (OOXML, OpenDocument). It keeps qualified names as written (e.g. `text:p`, `a:t`),
 * which is all the converters need, and ignores DTDs, comments and processing instructions.
 */

export interface XmlElement {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
}

export type XmlNode = XmlElement | string

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return safeCodePoint(Number.parseInt(entity.slice(2), 16)) ?? match
    }
    if (entity.startsWith('#')) return safeCodePoint(Number.parseInt(entity.slice(1), 10)) ?? match
    return ENTITIES[entity] ?? match
  })
}

function safeCodePoint(code: number): string | undefined {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : undefined
}

const ATTR_PATTERN = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g

/** Parses an XML string into an element tree. Throws on badly broken input. */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [] }
  const stack: XmlElement[] = [root]
  let pos = 0
  const length = xml.length

  while (pos < length) {
    const lt = xml.indexOf('<', pos)
    const textEnd = lt === -1 ? length : lt
    if (textEnd > pos) {
      const text = xml.slice(pos, textEnd)
      if (stack.length > 1) stack[stack.length - 1]?.children.push(decodeEntities(text))
    }
    if (lt === -1) break

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      pos = end === -1 ? length : end + 3
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      const text = xml.slice(lt + 9, end === -1 ? length : end)
      stack[stack.length - 1]?.children.push(text)
      pos = end === -1 ? length : end + 3
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2)
      pos = end === -1 ? length : end + 2
    } else if (xml.startsWith('<!', lt)) {
      pos = skipDeclaration(xml, lt)
    } else if (xml[lt + 1] === '/') {
      const end = xml.indexOf('>', lt)
      if (end === -1) throw new Error('Unexpected end of XML')
      const name = xml.slice(lt + 2, end).trim()
      // Pop to the matching element; tolerate stray closing tags.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]?.name === name) {
          stack.length = i
          break
        }
      }
      pos = end + 1
    } else {
      const end = findTagEnd(xml, lt)
      if (end === -1) throw new Error('Unexpected end of XML')
      let inner = xml.slice(lt + 1, end)
      const selfClosing = inner.endsWith('/')
      if (selfClosing) inner = inner.slice(0, -1)
      const nameMatch = /^[^\s/>]+/.exec(inner)
      if (!nameMatch) throw new Error('Invalid XML tag')
      const element: XmlElement = { name: nameMatch[0], attrs: {}, children: [] }
      for (const m of inner.slice(nameMatch[0].length).matchAll(ATTR_PATTERN)) {
        const key = m[1]
        if (key) element.attrs[key] = decodeEntities(m[3] ?? m[4] ?? '')
      }
      stack[stack.length - 1]?.children.push(element)
      if (!selfClosing) stack.push(element)
      pos = end + 1
    }
  }

  const first = root.children.find((c): c is XmlElement => typeof c !== 'string')
  if (!first) throw new Error('XML without root element')
  return first
}

/** Index of the `>` closing a start tag, skipping `>` inside quoted attribute values. */
function findTagEnd(xml: string, start: number): number {
  let quote: string | undefined
  for (let i = start + 1; i < xml.length; i++) {
    const ch = xml[i]
    if (quote) {
      if (ch === quote) quote = undefined
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      return i
    }
  }
  return -1
}

function skipDeclaration(xml: string, start: number): number {
  // <!DOCTYPE ... [ ... ]> may contain nested brackets.
  let depth = 0
  for (let i = start + 2; i < xml.length; i++) {
    const ch = xml[i]
    if (ch === '[') depth++
    else if (ch === ']') depth--
    else if (ch === '>' && depth <= 0) return i + 1
  }
  return xml.length
}

export function elements(node: XmlElement): XmlElement[] {
  return node.children.filter((c): c is XmlElement => typeof c !== 'string')
}

export function child(node: XmlElement | undefined, name: string): XmlElement | undefined {
  return node?.children.find((c): c is XmlElement => typeof c !== 'string' && c.name === name)
}

export function childrenNamed(node: XmlElement | undefined, name: string): XmlElement[] {
  return node ? elements(node).filter((c) => c.name === name) : []
}

/** Depth-first search for all descendants with the given name (not descending into matches). */
export function findAll(node: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of node.children) {
    if (typeof c === 'string') continue
    if (c.name === name) out.push(c)
    else findAll(c, name, out)
  }
  return out
}

export function findFirst(node: XmlElement, name: string): XmlElement | undefined {
  for (const c of node.children) {
    if (typeof c === 'string') continue
    if (c.name === name) return c
    const nested = findFirst(c, name)
    if (nested) return nested
  }
  return undefined
}
