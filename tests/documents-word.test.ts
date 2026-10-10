import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import * as XLSX from 'xlsx'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WordInputSchema, createWordDocument } from '../src/main/documents/create'
import {
  DOCUMENT_EXTENSIONS,
  DocumentError,
  extractDocument,
  isDocument,
} from '../src/main/documents/extract'
import { parseInline, parseMarkdown } from '../src/main/documents/markdown-parse'
import { rtfToText } from '../src/main/documents/rtf'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiw-docs-word-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(name: string, data: Uint8Array | string): string {
  const path = join(dir, name)
  writeFileSync(path, data)
  return path
}

const SAMPLE = `# Überschrift Größe

Ein Absatz mit **fett**, *kursiv*, \`code\` und [Link](https://example.com). Grüße äöüß.

## Liste

- Punkt eins
  - Unterpunkt
- Punkt zwei

1. Erstens
2. Zweitens

| Name | Wert |
| --- | ---: |
| Müller | 1,5 |
| Schäfer | 2 |

\`\`\`
const x = 1
\`\`\`

> Zitat hier

---

Ende.`

describe('document detection', () => {
  it('knows the supported extensions', () => {
    expect(DOCUMENT_EXTENSIONS.has('.docx')).toBe(true)
    expect(DOCUMENT_EXTENSIONS.size).toBe(12)
    expect(isDocument('Bericht.DOCX')).toBe(true)
    expect(isDocument('C:\\daten\\tabelle.xlsm')).toBe(true)
    expect(isDocument('folien.odp')).toBe(true)
    expect(isDocument('bild.png')).toBe(false)
    expect(isDocument('notizen.txt')).toBe(false)
  })
})

describe('Word round trip (.docx)', () => {
  it('keeps headings, formatting, lists, tables and code', async () => {
    const path = write(
      'bericht.docx',
      await createWordDocument({ markdown: SAMPLE, title: 'Test' }),
    )
    const doc = await extractDocument(path)
    expect(doc.kind).toBe('word')
    expect(doc.truncated).toBe(false)
    const md = doc.markdown
    expect(md).toContain('# Überschrift Größe')
    expect(md).toContain('## Liste')
    expect(md).toContain('**fett**')
    expect(md).toContain('*kursiv*')
    expect(md).toContain('`code`')
    expect(md).toContain('[Link](https://example.com)')
    expect(md).toContain('Grüße äöüß')
    expect(md).toMatch(/^- Punkt eins$/m)
    expect(md).toMatch(/^\s+- Unterpunkt$/m)
    expect(md).toMatch(/^1\. Erstens$/m)
    expect(md).toMatch(/^2\. Zweitens$/m)
    expect(md).toContain('| Name | Wert |')
    expect(md).toContain('| Müller | 1,5 |')
    expect(md).toContain('```\nconst x = 1\n```')
    expect(md).toContain('> Zitat hier')
    expect(doc.summary).toMatch(/^Word-Dokument, .*≈\d+ Wörter$/)
  })

  it('stores the title in the document properties', async () => {
    const data = await createWordDocument({ markdown: 'Text', title: 'Quartalsbericht Ä' })
    const files = (await import('fflate')).unzipSync(data)
    const core = new TextDecoder().decode(files['docProps/core.xml'])
    expect(core).toContain('<dc:title>Quartalsbericht Ä</dc:title>')
  })

  it('creates a valid document from empty Markdown', async () => {
    const path = write('leer.docx', await createWordDocument({ markdown: '' }))
    const doc = await extractDocument(path)
    expect(doc.markdown).toBe('')
  })

  it('rejects invalid input with a German message', async () => {
    await expect(createWordDocument({ markdown: 42 } as never)).rejects.toThrow(DocumentError)
    await expect(createWordDocument({ markdown: 42 } as never)).rejects.toThrow(/Ungültige Eingabe/)
    expect(WordInputSchema.safeParse({ markdown: '# x' }).success).toBe(true)
  })

  it('truncates long documents with a German marker', async () => {
    const markdown = Array.from({ length: 200 }, (_, i) => `Absatz ${i} mit etwas Text.`).join(
      '\n\n',
    )
    const path = write('lang.docx', await createWordDocument({ markdown }))
    const doc = await extractDocument(path, { maxChars: 500 })
    expect(doc.truncated).toBe(true)
    expect(doc.markdown.length).toBeLessThan(560)
    expect(doc.markdown.endsWith('[… gekürzt]')).toBe(true)
  })
})

describe('Markdown parser', () => {
  it('parses blocks', () => {
    const blocks = parseMarkdown(SAMPLE)
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'list',
      'list',
      'table',
      'code',
      'quote',
      'hr',
      'paragraph',
    ])
    const list = blocks[3]
    expect(list?.type === 'list' && list.items.map((i) => i.level)).toEqual([0, 1, 0])
    const table = blocks[5]
    expect(table?.type === 'table' && table.align).toEqual([undefined, 'right'])
  })

  it('parses inline formatting', () => {
    const runs = parseInline('a **b *c*** `d*e*` [f](https://x.de) \\*g\\*')
    expect(runs).toEqual([
      { text: 'a ' },
      { text: 'b ', bold: true },
      { text: 'c', bold: true, italic: true },
      { text: ' ' },
      { text: 'd*e*', code: true },
      { text: ' ' },
      { text: 'f', link: 'https://x.de' },
      { text: ' *g*' },
    ])
  })

  it('stays fast on long paragraphs and unbalanced markers', () => {
    const started = Date.now()
    expect(parseInline('**fett** und *kursiv* '.repeat(5_000))).toHaveLength(20_000)
    parseInline('*'.repeat(20_000))
    parseInline('**a '.repeat(5_000))
    parseInline('_x '.repeat(10_000))
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('does not turn unsafe links into hyperlinks', () => {
    expect(parseInline('[x](javascript:alert(1))')[0]).not.toHaveProperty('link')
  })
})

describe('OpenDocument text (.odt)', () => {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.3">
  <office:automatic-styles>
    <style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
    <style:style style:name="T2" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
    <text:list-style style:name="L2"><text:list-level-style-number text:level="1"/></text:list-style>
  </office:automatic-styles>
  <office:body><office:text>
    <text:h text:outline-level="1">Größe &amp; Maß</text:h>
    <text:p>Hallo <text:span text:style-name="T1">fett</text:span> und <text:span text:style-name="T2">kursiv</text:span>,<text:s/>mit <text:a xlink:href="https://example.org">Link</text:a>.<text:note><text:note-body><text:p>Eine Fußnote</text:p></text:note-body></text:note></text:p>
    <text:h text:outline-level="2">Liste</text:h>
    <text:list>
      <text:list-item><text:p>Äpfel</text:p>
        <text:list><text:list-item><text:p>grün</text:p></text:list-item></text:list>
      </text:list-item>
      <text:list-item><text:p>Birnen</text:p></text:list-item>
    </text:list>
    <text:list text:style-name="L2">
      <text:list-item><text:p>Eins</text:p></text:list-item>
      <text:list-item><text:p>Zwei</text:p></text:list-item>
    </text:list>
    <table:table table:name="T">
      <table:table-column table:number-columns-repeated="2"/>
      <table:table-header-rows><table:table-row>
        <table:table-cell><text:p>Name</text:p></table:table-cell>
        <table:table-cell><text:p>Ort</text:p></table:table-cell>
      </table:table-row></table:table-header-rows>
      <table:table-row>
        <table:table-cell><text:p>Müller</text:p></table:table-cell>
        <table:table-cell><text:p>Köln | Mitte</text:p></table:table-cell>
        <table:table-cell table:number-columns-repeated="1000"/>
      </table:table-row>
    </table:table>
  </office:text></office:body>
</office:document-content>`

  function odt(manifestExtra = ''): Uint8Array {
    return zipSync({
      mimetype: strToU8('application/vnd.oasis.opendocument.text'),
      'content.xml': strToU8(content),
      'META-INF/manifest.xml': strToU8(
        `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">${manifestExtra}</manifest:manifest>`,
      ),
    })
  }

  it('converts headings, inline styles, lists, tables and notes', async () => {
    const doc = await extractDocument(write('brief.odt', odt()))
    expect(doc.kind).toBe('word')
    const md = doc.markdown
    expect(md).toContain('# Größe & Maß')
    expect(md).toContain('Hallo **fett** und *kursiv*, mit [Link](https://example.org).[^1]')
    expect(md).toContain('## Liste')
    expect(md).toContain('- Äpfel\n  - grün\n- Birnen')
    expect(md).toContain('1. Eins\n2. Zwei')
    expect(md).toContain('| Name | Ort |')
    expect(md).toContain('| Müller | Köln \\| Mitte |')
    expect(md).toContain('[^1]: Eine Fußnote')
    expect(doc.summary).toMatch(/^OpenDocument-Text, ≈\d+ Wörter$/)
  })

  it('reports password-protected files', async () => {
    const path = write(
      'geheim.odt',
      odt('<manifest:file-entry><manifest:encryption-data/></manifest:file-entry>'),
    )
    await expect(extractDocument(path)).rejects.toThrow(
      'Die Datei ist passwortgeschützt und kann nicht gelesen werden.',
    )
  })
})

describe('RTF', () => {
  // Built from parts so the escapes stay literal in the source.
  const uni = (code: number): string => `\\u${code}?`
  const rtf = [
    '{\\rtf1\\ansi\\ansicpg1252\\deff0',
    '{\\fonttbl{\\f0\\fswiss Arial;}{\\f1 Times New Roman;}}',
    '{\\colortbl;\\red255\\green0\\blue0;}',
    '{\\stylesheet{\\s0 Normal;}}',
    '{\\info{\\title Geheimer Titel}}',
    '{\\*\\generator Testprogramm;}',
    "\\pard\\plain Gr\\'fc\\'dfe aus K\\'f6ln: \\'e4\\'f6\\'fc \\'c4\\'d6\\'dc\\par",
    `Unicode: ${uni(-31900)} ${uni(8364)} 5\\tab Spalte\\par`,
    '{\\field{\\*\\fldinst HYPERLINK "https://x.de"}{\\fldrslt Linktext}}\\par',
    '\\trowd\\cellx1000\\cellx2000',
    '\\pard\\intbl Name\\cell Ort\\cell\\row',
    "\\pard\\intbl M\\'fcller\\cell Bonn\\cell\\row",
    '\\pard Danach\\par',
    '{\\pict\\pngblip 89504e470d0a}',
    '}',
  ].join('\n')

  it('decodes code-page and Unicode escapes and skips non-text groups', () => {
    const text = rtfToText(rtf)
    expect(text).toContain('Grüße aus Köln: äöü ÄÖÜ')
    expect(text).toContain('Unicode: 荤 € 5\tSpalte')
    expect(text).toContain('Linktext')
    expect(text).toContain('| Name | Ort |\n| --- | --- |\n| Müller | Bonn |')
    expect(text).toMatch(/\| Müller \| Bonn \|\n\nDanach/)
    for (const hidden of [
      'Arial',
      'Times',
      'Normal',
      'Geheimer',
      'Testprogramm',
      'HYPERLINK',
      '8950',
    ]) {
      expect(text).not.toContain(hidden)
    }
  })

  it('extracts .rtf files', async () => {
    const doc = await extractDocument(write('brief.rtf', Buffer.from(rtf, 'latin1')))
    expect(doc.kind).toBe('word')
    expect(doc.markdown).toContain('Grüße aus Köln')
    expect(doc.summary).toMatch(/^RTF-Dokument, ≈\d+ Wörter$/)
  })

  it('reads RTF saved with a .doc extension', async () => {
    const doc = await extractDocument(write('alt.doc', Buffer.from(rtf, 'latin1')))
    expect(doc.markdown).toContain('Grüße aus Köln')
  })
})

describe('legacy Word (.doc)', () => {
  // Saved by LibreOffice from the SAMPLE document (binary .doc cannot be generated in JS).
  const fixtures = join(import.meta.dirname, 'fixtures', 'documents')

  it('extracts text, umlauts and tables', async () => {
    const doc = await extractDocument(join(fixtures, 'sample.doc'))
    expect(doc.kind).toBe('word')
    expect(doc.markdown).toContain('Überschrift Größe\n\nEin Absatz mit fett')
    expect(doc.markdown).toContain('Grüße äöüß')
    expect(doc.markdown).toContain('| Name | Wert |\n| --- | --- |\n| Müller | 1,5 |')
    expect(doc.summary).toMatch(/^Word-Dokument \(\.doc\), ≈\d+ Wörter$/)
  })

  it('detects password protection', async () => {
    await expect(extractDocument(join(fixtures, 'encrypted.doc'))).rejects.toThrow(
      'Die Datei ist passwortgeschützt und kann nicht gelesen werden.',
    )
  })
})

describe('errors', () => {
  it('rejects corrupt Word files', async () => {
    const path = write('kaputt.docx', 'das ist kein Word-Dokument')
    await expect(extractDocument(path)).rejects.toThrow(DocumentError)
    await expect(extractDocument(path)).rejects.toThrow(/beschädigt/)
  })

  it('rejects a zip that is not a Word document', async () => {
    const path = write('zip.docx', zipSync({ 'a.txt': strToU8('hallo') }))
    await expect(extractDocument(path)).rejects.toThrow(/beschädigt/)
  })

  it('rejects corrupt legacy .doc files', async () => {
    const path = write('kaputt.doc', Buffer.alloc(2048, 7))
    await expect(extractDocument(path)).rejects.toThrow(DocumentError)
  })

  it('detects password-protected Office files', async () => {
    // Encrypted OOXML: an OLE container with an EncryptedPackage stream.
    const cfb = XLSX.CFB.utils.cfb_new()
    XLSX.CFB.utils.cfb_add(cfb, 'EncryptionInfo', Buffer.alloc(64, 1))
    XLSX.CFB.utils.cfb_add(cfb, 'EncryptedPackage', Buffer.alloc(512, 2))
    const data = XLSX.CFB.write(cfb, { type: 'buffer' }) as Buffer
    for (const name of ['geheim.docx', 'geheim.xlsx', 'geheim.pptx']) {
      await expect(extractDocument(write(name, data))).rejects.toThrow(
        'Die Datei ist passwortgeschützt und kann nicht gelesen werden.',
      )
    }
  })

  it('rejects unsupported, missing and empty files', async () => {
    await expect(extractDocument(write('a.txt', 'x'))).rejects.toThrow(/nicht unterstützt/)
    await expect(extractDocument(join(dir, 'fehlt.docx'))).rejects.toThrow(/nicht gefunden/)
    await expect(extractDocument(write('leer.docx', ''))).rejects.toThrow(/leer/)
  })
})
