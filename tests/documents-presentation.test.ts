import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PresentationInputSchema,
  createPresentation,
  imageDimensions,
} from '../src/main/documents/create'
import { DocumentError, extractDocument } from '../src/main/documents/extract'

// 1x1 transparent PNG
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiw-docs-pres-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(name: string, data: Uint8Array | string): string {
  const path = join(dir, name)
  writeFileSync(path, data)
  return path
}

describe('PowerPoint round trip (.pptx)', () => {
  it('keeps titles, bullets, notes and images', async () => {
    const image = write('diagramm.png', Buffer.from(PNG_BASE64, 'base64'))
    const data = await createPresentation({
      title: 'Jahresrückblick 2024',
      slides: [
        {
          title: 'Agenda & Ziele',
          bullets: ['Umsatz steigern', '  Neue Märkte', '  Größere Kunden', 'Kosten senken'],
          notes: 'Begrüßung äöüß\nDann zur Agenda',
        },
        { title: 'Grafik', imagePath: image },
        { title: 'Beides', bullets: ['Text links'], imagePath: image },
      ],
    })
    const doc = await extractDocument(write('vortrag.pptx', data))
    expect(doc.kind).toBe('presentation')
    expect(doc.summary).toBe('PowerPoint, 4 Folien')
    const md = doc.markdown
    expect(md).toContain('## Folie 1: Jahresrückblick 2024')
    expect(md).toContain(
      '## Folie 2: Agenda & Ziele\n\n- Umsatz steigern\n  - Neue Märkte\n  - Größere Kunden\n- Kosten senken',
    )
    expect(md).toContain('> Notizen: Begrüßung äöüß\n> Dann zur Agenda')
    expect(md).toContain('## Folie 3: Grafik\n\n[Bild: diagramm.png]')
    expect(md).toContain('## Folie 4: Beides\n\n- Text links\n\n[Bild: diagramm.png]')
  })

  it('creates 16:9 slides with real title placeholders', async () => {
    const files = unzipSync(await createPresentation({ slides: [{ title: 'Nur eine' }] }))
    const presentation = strFromU8(files['ppt/presentation.xml'] ?? new Uint8Array())
    expect(presentation).toMatch(/<p:sldSz cx="12192000" cy="6858000"/)
    const slide = strFromU8(files['ppt/slides/slide1.xml'] ?? new Uint8Array())
    expect(slide).toContain('type="title"')
  })

  it('validates input', async () => {
    expect(PresentationInputSchema.safeParse({ slides: [] }).success).toBe(false)
    expect(PresentationInputSchema.safeParse({ title: 'Nur Titel', slides: [] }).success).toBe(true)
    const tooMany = { slides: Array.from({ length: 201 }, (_, i) => ({ title: `F${i}` })) }
    await expect(createPresentation(tooMany)).rejects.toThrow(/Ungültige Eingabe/)
    await expect(
      createPresentation({ slides: [{ title: 'x', imagePath: join(dir, 'fehlt.png') }] }),
    ).rejects.toThrow(/Bild nicht gefunden/)
    const fake = write('fake.png', 'kein Bild')
    await expect(createPresentation({ slides: [{ title: 'x', imagePath: fake }] })).rejects.toThrow(
      DocumentError,
    )
  })

  it('reads image dimensions', () => {
    expect(imageDimensions(Buffer.from(PNG_BASE64, 'base64'))).toEqual({
      width: 1,
      height: 1,
      mime: 'image/png',
    })
    const gif = Buffer.from('R0lGODlhAgADAIAAAP///wAAACwAAAAAAgADAAACAoRRADs=', 'base64')
    expect(imageDimensions(gif)).toMatchObject({ width: 2, height: 3, mime: 'image/gif' })
  })

  it('rejects corrupt presentations', async () => {
    await expect(extractDocument(write('kaputt.pptx', 'nein'))).rejects.toThrow(/beschädigt/)
    await expect(
      extractDocument(write('leer.pptx', zipSync({ 'a.txt': strToU8('x') }))),
    ).rejects.toThrow(DocumentError)
  })
})

describe('OpenDocument presentation (.odp)', () => {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0">
  <office:body><office:presentation>
    <draw:page draw:name="page1">
      <draw:frame presentation:class="title"><draw:text-box><text:p>Überblick</text:p></draw:text-box></draw:frame>
      <draw:frame presentation:class="outline"><draw:text-box>
        <text:list><text:list-item><text:p>Erster Punkt</text:p>
          <text:list><text:list-item><text:p>Unterpunkt äöü</text:p></text:list-item></text:list>
        </text:list-item><text:list-item><text:p>Zweiter Punkt</text:p></text:list-item></text:list>
      </draw:text-box></draw:frame>
      <draw:frame><draw:image/><svg:title>Logo</svg:title></draw:frame>
      <presentation:notes><draw:page-thumbnail/>
        <draw:frame presentation:class="notes"><draw:text-box><text:p>Notiz für Folie 1</text:p></draw:text-box></draw:frame>
      </presentation:notes>
    </draw:page>
    <draw:page draw:name="page2">
      <draw:frame presentation:class="title"><draw:text-box><text:p>Zahlen</text:p></draw:text-box></draw:frame>
      <draw:frame><table:table>
        <table:table-row><table:table-cell><text:p>Jahr</text:p></table:table-cell><table:table-cell><text:p>Umsatz</text:p></table:table-cell></table:table-row>
        <table:table-row><table:table-cell><text:p>2024</text:p></table:table-cell><table:table-cell><text:p>1,2 Mio</text:p></table:table-cell></table:table-row>
      </table:table></draw:frame>
      <draw:custom-shape><text:p>Freier Text</text:p></draw:custom-shape>
    </draw:page>
  </office:presentation></office:body>
</office:document-content>`

  it('converts slides, bullets, tables and notes', async () => {
    const data = zipSync({
      mimetype: strToU8('application/vnd.oasis.opendocument.presentation'),
      'content.xml': strToU8(content),
    })
    const doc = await extractDocument(write('folien.odp', data))
    expect(doc.kind).toBe('presentation')
    expect(doc.summary).toBe('OpenDocument-Präsentation, 2 Folien')
    expect(doc.markdown).toBe(
      [
        '## Folie 1: Überblick',
        '- Erster Punkt\n  - Unterpunkt äöü\n- Zweiter Punkt',
        '[Bild: Logo]',
        '> Notizen: Notiz für Folie 1',
        '## Folie 2: Zahlen',
        '| Jahr | Umsatz |\n| --- | --- |\n| 2024 | 1,2 Mio |',
        'Freier Text',
      ].join('\n\n'),
    )
  })
})
