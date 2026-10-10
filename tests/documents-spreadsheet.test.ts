import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import * as XLSX from 'xlsx'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SpreadsheetInputSchema,
  createSpreadsheet,
  sanitizeSheetNames,
} from '../src/main/documents/create'
import { DocumentError, extractDocument } from '../src/main/documents/extract'
import { decodeText, detectDelimiter } from '../src/main/documents/spreadsheet'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiw-docs-sheet-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(name: string, data: Uint8Array | string): string {
  const path = join(dir, name)
  writeFileSync(path, data)
  return path
}

describe('Excel round trip (.xlsx)', () => {
  const input = {
    sheets: [
      {
        name: 'Umsatz',
        rows: [
          ['Produkt', 'Menge', 'Preis'],
          ['Äpfel', 3, 1.25],
          ['Bügeleisen', 1, 39.9],
          ['Summe', '=SUM(B2:B3)', null],
          ['Text', "'=kein Formel", true],
        ],
      },
      {
        name: 'Kosten/Q1',
        rows: [
          [1, 2],
          [3, 4],
        ],
        header: false,
      },
    ],
  }

  it('keeps sheets, umlauts, numbers and formulas', async () => {
    const path = write('umsatz.xlsx', createSpreadsheet(input))
    const doc = await extractDocument(path)
    expect(doc.kind).toBe('spreadsheet')
    const md = doc.markdown
    expect(md).toContain('## Umsatz')
    expect(md).toContain('| # | Produkt | Menge | Preis |')
    expect(md).toContain('| 2 | Äpfel | 3 | 1.25 |')
    expect(md).toContain('| 3 | Bügeleisen | 1 | 39.9 |')
    expect(md).toContain('| 4 | Summe | =SUM(B2:B3) |  |')
    expect(md).toContain('| 5 | Text | =kein Formel | TRUE |')
    // Invalid characters are replaced in sheet names.
    expect(md).toContain('## Kosten_Q1')
    expect(md).toContain('| # | A | B |')
    expect(md).toContain('| 1 | 1 | 2 |')
    expect(doc.summary).toBe('Excel, 2 Tabellenblätter (Umsatz: 5×3, Kosten_Q1: 2×2)')
  })

  it('writes real formulas, a bold frozen header and recalculation on open', () => {
    const files = unzipSync(createSpreadsheet(input))
    const sheet1 = strFromU8(files['xl/worksheets/sheet1.xml'] ?? new Uint8Array())
    const sheet2 = strFromU8(files['xl/worksheets/sheet2.xml'] ?? new Uint8Array())
    const styles = strFromU8(files['xl/styles.xml'] ?? new Uint8Array())
    const workbook = strFromU8(files['xl/workbook.xml'] ?? new Uint8Array())
    expect(sheet1).toContain('<f>SUM(B2:B3)</f>')
    expect(sheet1).toContain('state="frozen"')
    expect(sheet1).toMatch(/<c r="A1" s="(\d+)"/)
    expect(sheet1).toContain('<autoFilter')
    expect(sheet2).not.toContain('state="frozen"')
    expect(sheet2).not.toMatch(/<c r="A1" s=/)
    expect(styles).toContain('<b/>')
    expect(workbook).toContain('fullCalcOnLoad="1"')

    // SheetJS reads it back with the formula and the column widths.
    const wb = XLSX.read(createSpreadsheet(input), { cellFormula: true, sheetStubs: true })
    expect(wb.SheetNames).toEqual(['Umsatz', 'Kosten_Q1'])
    expect(wb.Sheets.Umsatz?.B4?.f).toBe('SUM(B2:B3)')
    expect(wb.Sheets.Umsatz?.A2?.v).toBe('Äpfel')
    expect(wb.Sheets.Umsatz?.C2?.v).toBe(1.25)
  })

  it('sanitizes sheet names like Excel', () => {
    expect(
      sanitizeSheetNames([
        'Umsatz [2024]: Q1/Q2?',
        'Ein sehr langer Tabellenname der zu lang ist',
        'Daten',
        'daten',
        '',
        "'Zitat'",
        'History',
      ]),
    ).toEqual([
      'Umsatz _2024__ Q1_Q2_',
      'Ein sehr langer Tabellenname de',
      'Daten',
      'daten (2)',
      'Tabelle5',
      'Zitat',
      'History_',
    ])
    const names = sanitizeSheetNames(Array.from({ length: 3 }, () => 'X'.repeat(40)))
    expect(names.every((n) => n.length <= 31)).toBe(true)
    expect(new Set(names).size).toBe(3)
  })

  it('validates limits', () => {
    expect(() => createSpreadsheet({ sheets: [] })).toThrow(DocumentError)
    const many = { sheets: Array.from({ length: 51 }, (_, i) => ({ name: `S${i}`, rows: [] })) }
    expect(() => createSpreadsheet(many)).toThrow(/Ungültige Eingabe/)
    const big = {
      sheets: [{ name: 'A', rows: Array.from({ length: 1001 }, () => Array(100).fill(1)) }],
    }
    expect(SpreadsheetInputSchema.safeParse(big).success).toBe(false)
    expect(() => createSpreadsheet(big)).toThrow(DocumentError)
  })

  it('formats dates and caps rows and columns', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Datum', 'Zeit'],
      [new Date(Date.UTC(2024, 2, 15)), 0.5],
    ])
    if (sheet.A2) sheet.A2.z = 'dd.mm.yyyy'
    if (sheet.B2) sheet.B2.z = 'hh:mm'
    const wide = XLSX.utils.aoa_to_sheet(
      Array.from({ length: 600 }, (_, r) => Array.from({ length: 45 }, (_, c) => r * 100 + c)),
    )
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, sheet, 'Termine')
    XLSX.utils.book_append_sheet(wb, wide, 'Groß')
    const path = write('daten.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
    const doc = await extractDocument(path)
    expect(doc.markdown).toContain('| 2 | 2024-03-15 | 12:00 |')
    expect(doc.markdown).toContain('## Groß')
    expect(doc.markdown).toContain(
      '*… 100 weitere Zeilen ausgelassen; … 5 weitere Spalten ausgelassen*',
    )
    expect(doc.markdown).not.toContain('| 59900 |')
    expect(doc.summary).toContain('Groß: 600×45')
  })
})

describe('OpenDocument spreadsheet (.ods) and legacy .xls', () => {
  function book(): XLSX.WorkBook {
    const wb = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Name', 'Wert'],
      ['Größe', 7],
      ['Maß', 8],
    ])
    sheet.B4 = { t: 'n', v: 15, f: 'SUM(B2:B3)' }
    sheet['!ref'] = 'A1:B4'
    XLSX.utils.book_append_sheet(wb, sheet, 'Übersicht')
    return wb
  }

  it('reads .ods', async () => {
    const path = write('t.ods', XLSX.write(book(), { type: 'buffer', bookType: 'ods' }))
    const doc = await extractDocument(path)
    expect(doc.markdown).toContain('## Übersicht')
    expect(doc.markdown).toContain('| 2 | Größe | 7 |')
    expect(doc.markdown).toMatch(/=SUM\(B2:B3\) → 15|=of:=SUM/i)
    expect(doc.summary).toMatch(/^OpenDocument-Tabelle, 1 Tabellenblatt/)
  })

  it('reads .xls (BIFF8)', async () => {
    const path = write('t.xls', XLSX.write(book(), { type: 'buffer', bookType: 'xls' }))
    const doc = await extractDocument(path)
    expect(doc.markdown).toContain('| 3 | Maß | 8 |')
    // The SheetJS BIFF writer stores values only (no formulas).
    expect(doc.markdown).toContain('| 4 |  | 15 |')
    expect(doc.summary).toBe('Excel, 1 Tabellenblatt (Übersicht: 4×2)')
  })

  it('rejects corrupt files', async () => {
    await expect(extractDocument(write('x.xlsx', 'kein Excel'))).rejects.toThrow(/beschädigt/)
    await expect(
      extractDocument(write('y.ods', zipSync({ 'a.txt': strToU8('x') }))),
    ).rejects.toThrow(DocumentError)
  })
})

describe('CSV and TSV', () => {
  it('reads semicolon CSV with a UTF-8 BOM', async () => {
    const text = 'Name;Ort;Betrag\nMüller;Köln;"1.234,56"\nSchäfer;"Berlin; Mitte";7\n'
    const data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    const doc = await extractDocument(write('liste.csv', data))
    expect(doc.kind).toBe('spreadsheet')
    expect(doc.markdown).toContain('| Name | Ort | Betrag |')
    expect(doc.markdown).toContain('| Müller | Köln | 1.234,56 |')
    expect(doc.markdown).toContain('| Schäfer | Berlin; Mitte | 7 |')
    expect(doc.markdown).not.toMatch(/^##/m)
    expect(doc.summary).toBe('CSV, 3×3 (Trennzeichen „;“)')
  })

  it('reads Windows-1252 CSV and comma CSV with quotes', async () => {
    const doc = await extractDocument(
      write(
        'alt.csv',
        Buffer.from('Stadt,Einwohner\nMünchen,"1,5 Mio"\n"Zitat ""x""",3\n', 'latin1'),
      ),
    )
    expect(doc.markdown).toContain('| München | 1,5 Mio |')
    expect(doc.markdown).toContain('| Zitat "x" | 3 |')
    expect(doc.summary).toBe('CSV, 3×2 (Trennzeichen „,“)')
  })

  it('reads TSV', async () => {
    const doc = await extractDocument(write('t.tsv', 'a\tb\n1\tGrüße\n'))
    expect(doc.markdown).toContain('| 1 | Grüße |')
    expect(doc.summary).toBe('TSV, 2×2 (Trennzeichen Tab)')
  })

  it('treats a numeric first row as data', async () => {
    const doc = await extractDocument(write('zahlen.csv', '1;2\n3;4\n'))
    expect(doc.markdown).toContain('| A | B |')
    expect(doc.markdown).toContain('| 1 | 2 |')
  })

  it('caps long CSV files', async () => {
    const lines = ['Nr;Wert', ...Array.from({ length: 1200 }, (_, i) => `${i};x${i}`)]
    const doc = await extractDocument(write('lang.csv', lines.join('\n')))
    expect(doc.markdown).toContain('| 0 | x0 |')
    expect(doc.markdown).not.toContain('| 1100 | x1100 |')
    expect(doc.markdown).toMatch(/\d+ weitere Zeilen ausgelassen/)
    expect(doc.summary).toBe('CSV, 1.201×2 (Trennzeichen „;“)')
  })

  it('detects delimiters and encodings', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(detectDelimiter('a,b\n"1,5",2')).toBe(',')
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t')
    expect(detectDelimiter('a|b|c\n1|2|3')).toBe('|')
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x41, 0x00, 0xe4, 0x00]))).toBe('Aä')
    expect(decodeText(Buffer.from('Grüße', 'latin1'))).toBe('Grüße')
    expect(decodeText(Buffer.from('Grüße', 'utf8'))).toBe('Grüße')
  })
})
