import { readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { ChatSummary } from '@shared/schemas/chat'
import type { OutputFile } from '@shared/schemas/media'
import { classify, detectMime } from '../workspace/attachments'
import { isInside } from '../workspace/paths'

/** Folder name for generated files inside a project (code mode). */
export const PROJECT_OUTPUT_DIR = 'ai-output'

/** Where generated files of a chat are stored. */
export function outputsDir(
  dataDir: string,
  chat: Pick<ChatSummary, 'id' | 'mode' | 'projectPath'>,
): string {
  return chat.mode === 'code' && chat.projectPath
    ? join(chat.projectPath, PROJECT_OUTPUT_DIR)
    : join(dataDir, 'chats', chat.id, 'outputs')
}

/** Lists generated files (two levels deep), newest first. */
export function listOutputs(dir: string, limit = 200): OutputFile[] {
  const files: OutputFile[] = []
  const walk = (folder: string, depth: number) => {
    let entries: string[]
    try {
      entries = readdirSync(folder)
    } catch {
      return
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      const path = join(folder, name)
      const stat = statSync(path, { throwIfNoEntry: false })
      if (!stat) continue
      if (stat.isDirectory()) {
        if (depth < 1) walk(path, depth + 1)
        continue
      }
      const mimeType = detectMime(name)
      files.push({
        name,
        path,
        kind: classify(name, mimeType),
        mimeType,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      })
    }
  }
  walk(dir, 0)
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, limit)
}

/** Extensions that would run code when opened with the default app. */
const EXECUTABLE_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.ps1',
  '.psm1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.wsh',
  '.msi',
  '.msp',
  '.scr',
  '.lnk',
  '.hta',
  '.cpl',
  '.jar',
  '.reg',
  '.sh',
  '.app',
  '.desktop',
])

export function isExecutable(path: string): boolean {
  return EXECUTABLE_EXTENSIONS.has(extname(path).toLowerCase())
}

/** True if `path` lies inside one of the allowed roots. */
export function isAllowedPath(path: string, roots: string[]): boolean {
  return roots.some((root) => isInside(root, path))
}
