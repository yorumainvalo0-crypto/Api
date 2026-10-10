import { isAbsolute, relative, resolve } from 'node:path'

/** True if `path` is strictly inside `dir` (no traversal, not the directory itself). */
export function isInside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Resolves an aiw-file URL to a path, or undefined if it points outside the allowed root. */
export function resolveFileUrl(url: string, root: string): string | undefined {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return undefined
  }
  const target = resolve(decodeURIComponent(pathname.replace(/^\/+/, '')))
  return isInside(root, target) ? target : undefined
}
