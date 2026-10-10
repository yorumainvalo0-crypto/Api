// Common languages only (~40) keeps the bundle small; the full set adds ~1 MB.
import hljs from 'highlight.js/lib/common'

/** Files larger than this are shown without syntax highlighting. */
const HIGHLIGHT_LIMIT = 300 * 1024

const EXTENSION_LANGUAGES: Record<string, string> = {
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  htm: 'xml',
  html: 'xml',
  svg: 'xml',
  vue: 'xml',
  svelte: 'xml',
  csproj: 'xml',
  jsonc: 'json',
  json5: 'json',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  toml: 'ini',
  cfg: 'ini',
  conf: 'ini',
  bat: 'dos',
  cmd: 'dos',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  gradle: 'groovy',
}

const FILE_NAME_LANGUAGES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  '.gitignore': 'plaintext',
  '.env': 'bash',
}

/** highlight.js language for a file name, or null if unknown. */
export function languageFor(fileName: string): string | null {
  const lower = fileName.toLowerCase()
  const byName = FILE_NAME_LANGUAGES[lower]
  if (byName) return byName
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = lower.slice(dot + 1)
  const language = EXTENSION_LANGUAGES[ext] ?? ext
  return hljs.getLanguage(language) ? language : null
}

/** Escaped HTML with highlight.js spans (plain escaped text if unknown or too large). */
export function highlightCode(code: string, fileName: string): string {
  const language = languageFor(fileName)
  if (language && code.length <= HIGHLIGHT_LIMIT) {
    try {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value
    } catch {
      // Fall through to plain text.
    }
  }
  return escapeHtml(code)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
