import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATTACHMENT_LIMITS } from '@shared/schemas/chat'
import {
  AttachmentError,
  buildPromptBlocks,
  classify,
  detectMime,
  storeAttachment,
} from '../src/main/workspace/attachments'
import { isInside, resolveFileUrl } from '../src/main/workspace/paths'
import { fileUrl } from '@shared/ipc'

// 1x1 transparent PNG
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiw-att-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('classification', () => {
  it('detects common types', () => {
    expect(classify('a.png', detectMime('a.png'))).toBe('image')
    expect(classify('a.PDF', detectMime('a.PDF'))).toBe('pdf')
    expect(classify('m.glb', detectMime('m.glb'))).toBe('model3d')
    expect(classify('main.ts', detectMime('main.ts'))).toBe('text')
    expect(classify('Dockerfile', detectMime('Dockerfile'))).toBe('text')
    expect(classify('x.exe', detectMime('x.exe'))).toBe('file')
    // SVG is text for the model, not an image block.
    expect(classify('a.svg', detectMime('a.svg'))).toBe('text')
  })
})

describe('storeAttachment', () => {
  it('copies a file from disk and sanitizes the name', () => {
    const src = join(dir, 'notiz.md')
    writeFileSync(src, '# Hallo')
    const a = storeAttachment({ source: 'path', path: src }, join(dir, 'att'))
    expect(a.kind).toBe('text')
    expect(a.size).toBe(7)
    expect(readFileSync(a.path, 'utf8')).toBe('# Hallo')
    expect(isInside(join(dir, 'att'), a.path)).toBe(true)
  })

  it('stores pasted data such as screenshots', () => {
    const a = storeAttachment(
      { source: 'data', name: 'bild:1?.png', mimeType: 'image/png', base64: PNG_BASE64 },
      join(dir, 'att'),
    )
    expect(a.kind).toBe('image')
    expect(a.name).toBe('bild_1_.png')
  })

  it('rejects missing and oversized files', () => {
    expect(() =>
      storeAttachment({ source: 'path', path: join(dir, 'gibtsnicht.txt') }, dir),
    ).toThrow(AttachmentError)
    const big = Buffer.alloc(ATTACHMENT_LIMITS.maxImageBytes + 1).toString('base64')
    expect(() =>
      storeAttachment({ source: 'data', name: 'x.png', mimeType: 'image/png', base64: big }, dir),
    ).toThrow(/zu groß/)
  })
})

describe('buildPromptBlocks', () => {
  it('turns images, PDFs and text into model content blocks', () => {
    const att = join(dir, 'att')
    const img = storeAttachment(
      { source: 'data', name: 'a.png', mimeType: 'image/png', base64: PNG_BASE64 },
      att,
    )
    const pdf = storeAttachment(
      { source: 'data', name: 'b.pdf', mimeType: 'application/pdf', base64: 'JVBERi0xLjQ=' },
      att,
    )
    const txt = storeAttachment(
      {
        source: 'data',
        name: 'c.ts',
        mimeType: '',
        base64: Buffer.from('const x = 1').toString('base64'),
      },
      att,
    )
    const bin = storeAttachment(
      { source: 'data', name: 'd.bin', mimeType: '', base64: 'AAEC' },
      att,
    )

    const blocks = buildPromptBlocks('Was siehst du?', [img, pdf, txt, bin], { pdf: true })
    expect(blocks.map((b) => b.type)).toEqual(['image', 'document', 'text', 'text'])
    expect(blocks[0]).toMatchObject({ source: { media_type: 'image/png', data: PNG_BASE64 } })
    expect(blocks[2]).toMatchObject({ text: expect.stringContaining('const x = 1') })
    // Unsupported files are referenced by path in the final prompt text.
    expect(blocks[3]).toMatchObject({ text: expect.stringContaining('d.bin') })
    expect(blocks[3]).toMatchObject({ text: expect.stringContaining('Was siehst du?') })
  })

  it('falls back to a path reference for PDFs when the provider cannot read them', () => {
    const pdf = storeAttachment(
      { source: 'data', name: 'b.pdf', mimeType: 'application/pdf', base64: 'JVBERi0xLjQ=' },
      dir,
    )
    const blocks = buildPromptBlocks('Lies das', [pdf], { pdf: false })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'text', text: expect.stringContaining('b.pdf') })
  })
})

describe('file protocol paths', () => {
  it('only serves files inside the data directory', () => {
    const root = join(dir, 'data')
    const inside = join(root, 'chats', 'c1', 'a.png')
    expect(resolveFileUrl(fileUrl(inside), root)).toBe(inside)
    expect(resolveFileUrl(fileUrl(join(root, '..', 'secret.txt')), root)).toBeUndefined()
    expect(resolveFileUrl(fileUrl('/etc/passwd'), root)).toBeUndefined()
    expect(resolveFileUrl(fileUrl(root), root)).toBeUndefined()
    expect(resolveFileUrl('not a url', root)).toBeUndefined()
  })
})
