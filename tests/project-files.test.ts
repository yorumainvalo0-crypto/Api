import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isInsideOrSame,
  listProjectDir,
  normalizeRelPath,
  READ_FILE_LIMIT,
  readProjectFile,
  resolveInProject,
} from '../src/main/project/files'

let root: string
let outside: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiw-proj-'))
  outside = mkdtempSync(join(tmpdir(), 'aiw-outside-'))
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'Docs'))
  writeFileSync(join(root, 'b.txt'), 'bbb')
  writeFileSync(join(root, 'A.md'), '# Titel\n')
  writeFileSync(join(root, 'src', 'main.ts'), 'export const x = 1\n')
  writeFileSync(join(outside, 'secret.txt'), 'geheim')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('path safety', () => {
  it('accepts the root and children, rejects traversal', () => {
    expect(isInsideOrSame(root, root)).toBe(true)
    expect(isInsideOrSame(root, join(root, 'src', 'x'))).toBe(true)
    expect(isInsideOrSame(root, join(root, '..'))).toBe(false)
    expect(isInsideOrSame(root, outside)).toBe(false)
  })

  it('normalizes relative paths', () => {
    expect(normalizeRelPath('')).toBe('')
    expect(normalizeRelPath('src\\lib/./a.ts')).toBe('src/lib/a.ts')
    expect(normalizeRelPath('/src/')).toBe('src')
  })

  it('rejects traversal, absolute paths and escaping symlinks', async () => {
    await expect(resolveInProject(root, '../')).rejects.toThrow(/außerhalb/)
    await expect(resolveInProject(root, '../../etc/passwd')).rejects.toThrow(/außerhalb/)
    await expect(resolveInProject(root, outside)).rejects.toThrow(/außerhalb/)
    symlinkSync(outside, join(root, 'link'), 'dir')
    await expect(listProjectDir(root, 'link')).rejects.toThrow(/außerhalb/)
    await expect(readProjectFile(root, 'link/secret.txt')).rejects.toThrow(/außerhalb/)
  })

  it('rejects a project path that is not a directory', async () => {
    await expect(listProjectDir(join(root, 'b.txt'), '')).rejects.toThrow(/kein Ordner/)
    await expect(listProjectDir(join(root, 'nope'), '')).rejects.toThrow(/nicht gefunden/)
    await expect(listProjectDir('relative/path', '')).rejects.toThrow(/absolut/)
  })
})

describe('listProjectDir', () => {
  it('lists the root dirs-first, sorted, without .git', async () => {
    const entries = await listProjectDir(root, '')
    expect(entries.map((e) => e.name)).toEqual(['Docs', 'src', 'A.md', 'b.txt'])
    expect(entries.find((e) => e.name === 'b.txt')).toEqual({
      name: 'b.txt',
      relPath: 'b.txt',
      isDir: false,
      size: 3,
    })
    expect(entries.find((e) => e.name === 'src')?.isDir).toBe(true)
  })

  it('lists subdirectories with posix relPaths', async () => {
    const entries = await listProjectDir(root, 'src')
    expect(entries).toEqual([{ name: 'main.ts', relPath: 'src/main.ts', isDir: false, size: 19 }])
  })

  it('rejects files as directories', async () => {
    await expect(listProjectDir(root, 'b.txt')).rejects.toThrow(/Kein Ordner/)
  })
})

describe('readProjectFile', () => {
  it('reads text files', async () => {
    const file = await readProjectFile(root, 'src/main.ts')
    expect(file).toEqual({
      content: 'export const x = 1\n',
      size: 19,
      truncated: false,
      binary: false,
    })
  })

  it('detects binary files', async () => {
    writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]))
    const file = await readProjectFile(root, 'bin.dat')
    expect(file.binary).toBe(true)
    expect(file.content).toBe('')
    expect(file.size).toBe(4)
  })

  it('truncates large files', async () => {
    writeFileSync(join(root, 'big.txt'), 'a'.repeat(READ_FILE_LIMIT + 10))
    const file = await readProjectFile(root, 'big.txt')
    expect(file.truncated).toBe(true)
    expect(file.content.length).toBe(READ_FILE_LIMIT)
    expect(file.size).toBe(READ_FILE_LIMIT + 10)
  })

  it('rejects directories', async () => {
    await expect(readProjectFile(root, 'src')).rejects.toThrow(/Ordner/)
  })
})
