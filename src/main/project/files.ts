import { open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { DirEntry, FileContent } from '@shared/schemas/project'
import { isInside } from '../workspace/paths'

/** Maximum number of bytes returned by readProjectFile. */
export const READ_FILE_LIMIT = 1024 * 1024
/** Maximum number of entries returned for one directory. */
export const LIST_DIR_LIMIT = 5000
/** Entries never shown in the tree. */
const HIDDEN_NAMES = new Set(['.git'])

/** User-facing (German) error for invalid project paths. */
export class ProjectPathError extends Error {
  override name = 'ProjectPathError'
}

/** True if `path` equals `dir` or lies inside it (no traversal). */
export function isInsideOrSame(dir: string, path: string): boolean {
  return relative(resolve(dir), resolve(path)) === '' || isInside(dir, path)
}

/** Validates that `projectPath` is an existing directory and returns its real path. */
export async function resolveProjectRoot(projectPath: string): Promise<string> {
  if (!isAbsolute(projectPath)) {
    throw new ProjectPathError('Der Projektpfad muss absolut sein.')
  }
  let info
  try {
    info = await stat(projectPath)
  } catch {
    throw new ProjectPathError(`Projektordner nicht gefunden: ${projectPath}`)
  }
  if (!info.isDirectory()) {
    throw new ProjectPathError(`Der Projektpfad ist kein Ordner: ${projectPath}`)
  }
  return realpath(projectPath)
}

/**
 * Resolves `relPath` inside the project and rejects anything that leaves it,
 * including symlinks/junctions that point outside.
 */
export async function resolveInProject(
  projectPath: string,
  relPath: string,
): Promise<{ root: string; target: string }> {
  const root = await resolveProjectRoot(projectPath)
  if (relPath.includes('\0')) throw new ProjectPathError('Ungültiger Pfad.')
  const candidate = resolve(root, relPath)
  if (!isInsideOrSame(root, candidate)) {
    throw new ProjectPathError('Der Pfad liegt außerhalb des Projektordners.')
  }
  let target: string
  try {
    target = await realpath(candidate)
  } catch {
    throw new ProjectPathError(`Datei oder Ordner nicht gefunden: ${relPath}`)
  }
  if (!isInsideOrSame(root, target)) {
    throw new ProjectPathError('Der Pfad liegt außerhalb des Projektordners.')
  }
  return { root, target }
}

/** Normalizes a relative path to `/` separators without leading/trailing slashes. */
export function normalizeRelPath(relPath: string): string {
  return relPath
    .split(/[\\/]+/)
    .filter((part) => part !== '' && part !== '.')
    .join('/')
}

/** Lists one directory: directories first, then files, both sorted naturally. */
export async function listProjectDir(projectPath: string, relPath: string): Promise<DirEntry[]> {
  const { target } = await resolveInProject(projectPath, relPath)
  const info = await stat(target)
  if (!info.isDirectory()) throw new ProjectPathError(`Kein Ordner: ${relPath}`)

  const base = normalizeRelPath(relPath)
  const dirents = await readdir(target, { withFileTypes: true })
  const entries = await Promise.all(
    dirents
      .filter((d) => !HIDDEN_NAMES.has(d.name))
      .map(async (d): Promise<DirEntry> => {
        let isDir = d.isDirectory()
        let size = 0
        try {
          // Follows symlinks so linked folders can be expanded (reading them is still checked).
          const s = await stat(resolve(target, d.name))
          isDir = s.isDirectory()
          size = isDir ? 0 : s.size
        } catch {
          // Broken link or no permission: show it as a plain entry.
        }
        return { name: d.name, relPath: base ? `${base}/${d.name}` : d.name, isDir, size }
      }),
  )
  entries.sort(compareEntries)
  return entries.slice(0, LIST_DIR_LIMIT)
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })

export function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/** True if the buffer looks binary (contains a NUL byte). */
export function isBinary(buffer: Uint8Array): boolean {
  return buffer.includes(0)
}

/** Reads a text file (at most READ_FILE_LIMIT bytes); binary files return empty content. */
export async function readProjectFile(projectPath: string, relPath: string): Promise<FileContent> {
  const { target } = await resolveInProject(projectPath, relPath)
  const info = await stat(target)
  if (info.isDirectory()) throw new ProjectPathError(`Das ist ein Ordner: ${relPath}`)
  if (!info.isFile()) throw new ProjectPathError(`Keine reguläre Datei: ${relPath}`)

  const length = Math.min(info.size, READ_FILE_LIMIT)
  const buffer = Buffer.alloc(length)
  const handle = await open(target, 'r')
  let bytesRead = 0
  try {
    while (bytesRead < length) {
      const { bytesRead: n } = await handle.read(buffer, bytesRead, length - bytesRead, bytesRead)
      if (n === 0) break
      bytesRead += n
    }
  } finally {
    await handle.close()
  }
  const data = buffer.subarray(0, bytesRead)
  const binary = isBinary(data)
  return {
    content: binary ? '' : new TextDecoder('utf-8').decode(data),
    size: info.size,
    truncated: info.size > bytesRead,
    binary,
  }
}
