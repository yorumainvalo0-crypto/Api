import { posix } from 'node:path'
import { DocumentError, PASSWORD_MESSAGE, corruptMessage, toDocumentError } from './errors'
import { formatCount, markdownTable, tidyMarkdown, unwrapBold } from './markdown'
import {
  createOdfContext,
  isEncryptedOdf,
  odfBlocks,
  odfInline,
  odfTable,
  officeBody,
  type OdfContext,
} from './opendocument'
import type { ConvertedDocument } from './types'
import { openPackage, type Package } from './zip'
import { child, childrenNamed, elements, findAll, findFirst, type XmlElement } from './xml'

interface Slide {
  title: string
  hidden: boolean
  body: string[]
  notes: string
}

function renderSlides(slides: Slide[], label: string): ConvertedDocument {
  const sections = slides.map((slide, i) => {
    const heading = `## Folie ${i + 1}${slide.title ? `: ${slide.title}` : ''}${slide.hidden ? ' (ausgeblendet)' : ''}`
    const parts = [heading, ...slide.body]
    if (slide.notes) {
      const lines = slide.notes.split('\n').filter((l) => l.trim())
      parts.push(lines.map((line, j) => (j === 0 ? `> Notizen: ${line}` : `> ${line}`)).join('\n'))
    }
    return parts.join('\n\n')
  })
  const count = slides.length
  return {
    kind: 'presentation',
    markdown: tidyMarkdown(sections.join('\n\n')),
    summary: `${label}, ${formatCount(count)} ${count === 1 ? 'Folie' : 'Folien'}`,
  }
}

// ---------------------------------------------------------------------------
// PowerPoint (.pptx)

const PPTX_LABEL = 'PowerPoint-Dokument'

function relsPath(partPath: string): string {
  return posix.join(posix.dirname(partPath), '_rels', `${posix.basename(partPath)}.rels`)
}

function resolveTarget(partPath: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  return posix.normalize(posix.join(posix.dirname(partPath), target))
}

interface Relationship {
  id: string
  type: string
  target: string
}

function relationships(pkg: Package, partPath: string): Relationship[] {
  const rels = pkg.xml(relsPath(partPath))
  if (!rels) return []
  return childrenNamed(rels, 'Relationship')
    .filter((r) => r.attrs.TargetMode !== 'External')
    .map((r) => ({
      id: r.attrs.Id ?? '',
      type: r.attrs.Type ?? '',
      target: resolveTarget(partPath, r.attrs.Target ?? ''),
    }))
}

/** Slide part paths in presentation order, falling back to numeric file order. */
function slideOrder(pkg: Package): string[] {
  const presentationPath = 'ppt/presentation.xml'
  const presentation = pkg.xml(presentationPath)
  const rels = new Map(relationships(pkg, presentationPath).map((r) => [r.id, r.target]))
  const ordered: string[] = []
  const list = presentation && findFirst(presentation, 'p:sldIdLst')
  for (const id of list ? childrenNamed(list, 'p:sldId') : []) {
    const target = rels.get(id.attrs['r:id'] ?? '')
    if (target && pkg.has(target)) ordered.push(target)
  }
  if (ordered.length) return ordered
  const slideNumber = (p: string): number => Number(/slide(\d+)\.xml$/.exec(p)?.[1] ?? 0)
  return pkg
    .paths()
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
}

function placeholderType(shape: XmlElement): string | undefined {
  const nv =
    child(shape, 'p:nvSpPr') ?? child(shape, 'p:nvPicPr') ?? child(shape, 'p:nvGraphicFramePr')
  const ph = findFirst(child(nv ?? shape, 'p:nvPr') ?? shape, 'p:ph')
  if (!ph) return undefined
  return ph.attrs.type ?? 'body'
}

interface PptxParagraph {
  text: string
  level: number
  bullet: boolean
}

function pptxParagraphs(
  txBody: XmlElement | undefined,
  inBody: boolean,
  keepBreaks = false,
): PptxParagraph[] {
  const out: PptxParagraph[] = []
  for (const p of childrenNamed(txBody, 'a:p')) {
    let text = ''
    for (const part of elements(p)) {
      if (part.name === 'a:r' || part.name === 'a:fld') {
        text += childrenNamed(part, 'a:t')
          .map((t) => t.children.filter((c): c is string => typeof c === 'string').join(''))
          .join('')
      } else if (part.name === 'a:br') {
        text += keepBreaks ? '\n' : ' '
      }
    }
    text = text
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\s*\n\s*/g, keepBreaks ? '\n' : ' ')
      .trim()
    if (!text) continue
    const pPr = child(p, 'a:pPr')
    const explicitBullet = Boolean(child(pPr, 'a:buChar') ?? child(pPr, 'a:buAutoNum'))
    const noBullet = Boolean(child(pPr, 'a:buNone'))
    out.push({
      text,
      level: Math.min(8, Number(pPr?.attrs.lvl ?? '0') || 0),
      bullet: explicitBullet || (inBody && !noBullet),
    })
  }
  return out
}

function renderParagraphs(paragraphs: PptxParagraph[]): string {
  return paragraphs
    .map((p) => (p.bullet ? `${'  '.repeat(p.level)}- ${p.text}` : p.text))
    .join('\n')
}

function pptxTable(table: XmlElement): string {
  const rows = childrenNamed(table, 'a:tr').map((tr) =>
    childrenNamed(tr, 'a:tc')
      .filter((tc) => tc.attrs.hMerge !== '1' && tc.attrs.vMerge !== '1')
      .map((tc) =>
        pptxParagraphs(child(tc, 'a:txBody'), false)
          .map((p) => p.text)
          .join('\n'),
      ),
  )
  const [header, ...body] = rows
  return header ? markdownTable(header, body) : ''
}

function collectShapes(tree: XmlElement, slide: Slide, titleTypes: Set<string>): void {
  for (const el of elements(tree)) {
    switch (el.name) {
      case 'p:sp': {
        const type = placeholderType(el)
        if (type && ['dt', 'ftr', 'sldNum', 'hdr', 'sldImg'].includes(type)) break
        const inBody = type === 'body' || type === 'obj'
        const paragraphs = pptxParagraphs(child(el, 'p:txBody'), inBody)
        if (!paragraphs.length) break
        if (type && titleTypes.has(type) && !slide.title) {
          slide.title = paragraphs.map((p) => p.text).join(' ')
        } else {
          slide.body.push(renderParagraphs(paragraphs))
        }
        break
      }
      case 'p:grpSp':
        collectShapes(el, slide, titleTypes)
        break
      case 'p:graphicFrame': {
        const data = findFirst(el, 'a:graphicData')
        const table = data && child(data, 'a:tbl')
        const uri = data?.attrs.uri ?? ''
        if (table) slide.body.push(pptxTable(table))
        else if (uri.endsWith('/chart')) slide.body.push('[Diagramm]')
        else if (uri.endsWith('/diagram')) slide.body.push('[SmartArt-Grafik]')
        break
      }
      case 'p:pic': {
        const props = findFirst(el, 'p:cNvPr')
        // pptxgenjs stores "preencoded.png" for images passed as data.
        const description = (props?.attrs.descr ?? '').trim().replace(/^preencoded\.\w+$/, '')
        slide.body.push(description ? `[Bild: ${description}]` : '[Bild]')
        break
      }
      case 'mc:AlternateContent': {
        const choice = child(el, 'mc:Choice') ?? child(el, 'mc:Fallback')
        if (choice) collectShapes(choice, slide, titleTypes)
        break
      }
    }
  }
}

const SLIDE_TITLE_TYPES = new Set(['title', 'ctrTitle'])

function notesText(pkg: Package, slidePath: string): string {
  const rel = relationships(pkg, slidePath).find((r) => r.type.endsWith('/notesSlide'))
  const notes = rel && pkg.xml(rel.target)
  if (!notes) return ''
  const lines: string[] = []
  for (const shape of findAll(notes, 'p:sp')) {
    if (placeholderType(shape) !== 'body') continue
    lines.push(
      ...pptxParagraphs(child(shape, 'p:txBody'), false, true).map((p) =>
        p.bullet ? `- ${p.text}` : p.text,
      ),
    )
  }
  return lines.join('\n')
}

export function convertPptx(data: Buffer): ConvertedDocument {
  const pkg = openPackage(
    data,
    PPTX_LABEL,
    (p) => (p.startsWith('ppt/') && p.endsWith('.xml')) || p.endsWith('.rels'),
  )
  const paths = slideOrder(pkg)
  if (!pkg.has('ppt/presentation.xml') && !paths.length) {
    throw new DocumentError(corruptMessage(PPTX_LABEL))
  }
  const slides: Slide[] = []
  try {
    for (const path of paths) {
      const xml = pkg.xml(path)
      if (!xml) continue
      const slide: Slide = { title: '', hidden: xml.attrs.show === '0', body: [], notes: '' }
      const tree = findFirst(xml, 'p:spTree')
      if (tree) collectShapes(tree, slide, SLIDE_TITLE_TYPES)
      slide.notes = notesText(pkg, path)
      slides.push(slide)
    }
  } catch (error) {
    throw toDocumentError(error, PPTX_LABEL)
  }
  return renderSlides(slides, 'PowerPoint')
}

// ---------------------------------------------------------------------------
// OpenDocument presentation (.odp)

function odpShapes(node: XmlElement, ctx: OdfContext, slide: Slide): void {
  for (const el of elements(node)) {
    const cls = el.attrs['presentation:class']
    if (el.name === 'draw:g') {
      odpShapes(el, ctx, slide)
      continue
    }
    if (el.name === 'presentation:notes') continue
    if (cls && ['page-number', 'footer', 'date-time', 'header', 'page'].includes(cls)) continue
    if (el.name === 'draw:frame') {
      const textBox = child(el, 'draw:text-box')
      const table = child(el, 'table:table')
      if (cls === 'title' && textBox && !slide.title) {
        slide.title = elements(textBox)
          .map((p) => odfInline(p, ctx))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
        slide.title = unwrapBold(slide.title)
      } else if (textBox) {
        slide.body.push(odpTextBlocks(textBox, ctx, cls === 'outline'))
      } else if (table) {
        slide.body.push(odfTable(table, ctx))
      } else if (child(el, 'draw:image')) {
        const title = child(el, 'svg:title') ?? child(el, 'svg:desc')
        const text = title ? odfInline(title, ctx).trim() : ''
        slide.body.push(text ? `[Bild: ${text}]` : '[Bild]')
      } else if (child(el, 'draw:object') || child(el, 'draw:object-ole')) {
        slide.body.push('[Objekt]')
      }
      continue
    }
    // Shapes with text directly inside (draw:custom-shape, draw:rect, …).
    if (el.name.startsWith('draw:')) {
      const text = odpTextBlocks(el, ctx, false)
      if (text) slide.body.push(text)
    }
  }
}

/** Text box content; outline boxes render plain paragraphs as bullets. */
function odpTextBlocks(box: XmlElement, ctx: OdfContext, outline: boolean): string {
  const blocks = odfBlocks(box, ctx)
  if (!outline) return blocks.join('\n')
  return blocks.map((b) => (/^\s*(-|\d+\.)\s/.test(b) ? b : `- ${b}`)).join('\n')
}

export function convertOdp(data: Buffer): ConvertedDocument {
  const label = 'OpenDocument-Präsentation'
  const pkg = openPackage(data, label)
  if (isEncryptedOdf(pkg)) throw new DocumentError(PASSWORD_MESSAGE)
  const slides: Slide[] = []
  try {
    const content = pkg.xml('content.xml')
    const body = content && officeBody(content, 'office:presentation')
    if (!content || !body) throw new DocumentError(corruptMessage(label))
    const ctx = createOdfContext(pkg, content)
    for (const page of childrenNamed(body, 'draw:page')) {
      const slide: Slide = { title: '', hidden: false, body: [], notes: '' }
      odpShapes(page, ctx, slide)
      const notes = child(page, 'presentation:notes')
      if (notes) {
        slide.notes = findAll(notes, 'draw:frame')
          .filter((f) => f.attrs['presentation:class'] === 'notes')
          .map((f) => odfBlocks(f, ctx).join('\n'))
          .join('\n')
          .trim()
      }
      slides.push(slide)
    }
  } catch (error) {
    throw toDocumentError(error, label)
  }
  return renderSlides(slides, label)
}
