import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { GitCommitResult, GitFile, GitFileStatus, GitStatus } from '@shared/schemas/project'
import { isBinary, isInsideOrSame, READ_FILE_LIMIT, resolveProjectRoot } from './files'

/** Maximum diff size (characters) returned to the renderer. */
export const DIFF_LIMIT = 512 * 1024
/** Maximum number of untracked files rendered as synthetic diffs in one request. */
const UNTRACKED_DIFF_FILES = 50
const GIT_MAX_BUFFER = 64 * 1024 * 1024

export const GIT_MISSING_MESSAGE =
  'Git wurde nicht gefunden. Bitte Git installieren (https://git-scm.com) und die App neu starten.'
export const NOT_A_REPO_MESSAGE = 'Dieser Ordner ist kein Git-Repository.'

export class GitMissingError extends Error {
  override name = 'GitMissingError'
  constructor() {
    super(GIT_MISSING_MESSAGE)
  }
}

export interface GitResult {
  /** Process exit code (0 = success). */
  code: number
  stdout: string
  stderr: string
  /** Output exceeded the buffer and was cut. */
  truncated: boolean
}

/** Runs git without a shell. Rejects only with GitMissingError if git is not installed. */
export function runGit(args: string[], cwd: string, timeoutMs = 30_000): Promise<GitResult> {
  return new Promise((done, fail) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: GIT_MAX_BUFFER,
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout, stderr) => {
        if (!error) {
          done({ code: 0, stdout, stderr, truncated: false })
          return
        }
        const code = error.code
        if (code === 'ENOENT') {
          fail(new GitMissingError())
        } else if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          done({ code: 0, stdout, stderr, truncated: true })
        } else if (error.killed) {
          done({
            code: -1,
            stdout,
            stderr: `${stderr}\nZeitüberschreitung bei git ${args[0] ?? ''}`,
            truncated: false,
          })
        } else {
          done({
            code: typeof code === 'number' ? code : 1,
            stdout,
            stderr: stderr || error.message,
            truncated: false,
          })
        }
      },
    )
  })
}

/** Pathspec relative to the repository root, without glob interpretation. */
function topPathspec(path: string): string {
  return `:(top,literal)${path}`
}

async function isRepo(cwd: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--is-inside-work-tree'], cwd)
  return result.code === 0 && result.stdout.trim() === 'true'
}

// ---------------------------------------------------------------------------
// Status parsing (porcelain v1 with -b)

export interface ParsedGitStatus {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitFile[]
}

/** Parses the output of `git status --porcelain=v1 -b`. */
export function parseGitStatus(output: string): ParsedGitStatus {
  const result: ParsedGitStatus = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
  for (const rawLine of output.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.length < 3) continue
    if (line.startsWith('## ')) {
      Object.assign(result, parseBranchLine(line.slice(3)))
      continue
    }
    const x = line[0] ?? ' '
    const y = line[1] ?? ' '
    const rest = line.slice(3)
    if (x === '!' && y === '!') continue
    if (x === '?' && y === '?') {
      result.files.push({
        path: unquotePath(rest),
        origPath: null,
        status: 'untracked',
        staged: false,
      })
      continue
    }
    let path: string
    let origPath: string | null = null
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const [from, to] = splitRename(rest)
      path = to
      origPath = from
    } else {
      path = unquotePath(rest)
    }
    if (isConflict(x, y)) {
      result.files.push({ path, origPath: null, status: 'conflicted', staged: false })
      continue
    }
    const staged = mapCode(x)
    if (staged) {
      const keepOrig = x === 'R' || x === 'C'
      result.files.push({
        path,
        origPath: keepOrig ? origPath : null,
        status: staged,
        staged: true,
      })
    }
    const unstaged = mapCode(y)
    if (unstaged) {
      const keepOrig = y === 'R' || y === 'C'
      result.files.push({
        path,
        origPath: keepOrig ? origPath : null,
        status: unstaged,
        staged: false,
      })
    }
  }
  return result
}

function parseBranchLine(
  head: string,
): Pick<ParsedGitStatus, 'branch' | 'upstream' | 'ahead' | 'behind'> {
  const initial = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(head)
  if (initial) return { branch: initial[1] ?? null, upstream: null, ahead: 0, behind: 0 }
  if (head.startsWith('HEAD (no branch)')) {
    return { branch: null, upstream: null, ahead: 0, behind: 0 }
  }
  const match = /^(.+?)(?:\.\.\.(\S+))?(?: \[([^\]]*)\])?$/.exec(head)
  if (!match) return { branch: head, upstream: null, ahead: 0, behind: 0 }
  const tracking = match[3] ?? ''
  return {
    branch: match[1] ?? null,
    upstream: match[2] ?? null,
    ahead: Number(/ahead (\d+)/.exec(tracking)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(tracking)?.[1] ?? 0),
  }
}

function isConflict(x: string, y: string): boolean {
  return x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
}

function mapCode(code: string): GitFileStatus | null {
  switch (code) {
    case 'M':
    case 'T':
      return 'modified'
    case 'A':
    case 'C':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    default:
      return null
  }
}

/** Splits `old -> new` where either side may be C-quoted. */
function splitRename(rest: string): [string, string] {
  if (rest.startsWith('"')) {
    const end = findClosingQuote(rest)
    const from = unquotePath(rest.slice(0, end + 1))
    const to = rest.slice(end + 1).replace(/^ -> /, '')
    return [from, unquotePath(to)]
  }
  const index = rest.indexOf(' -> ')
  if (index === -1) return [unquotePath(rest), unquotePath(rest)]
  return [rest.slice(0, index), unquotePath(rest.slice(index + 4))]
}

function findClosingQuote(text: string): number {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '"') return i
  }
  return text.length - 1
}

const SIMPLE_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
}

/** Decodes git's C-style quoting (`"a\tb\303\244"`); unquoted input is returned unchanged. */
export function unquotePath(text: string): string {
  if (!(text.length >= 2 && text.startsWith('"') && text.endsWith('"'))) return text
  const inner = text.slice(1, -1)
  const bytes: number[] = []
  const encoder = new TextEncoder()
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i] ?? ''
    if (char !== '\\') {
      bytes.push(...encoder.encode(char))
      continue
    }
    const next = inner[i + 1] ?? ''
    const octal = /^[0-7]{3}/.exec(inner.slice(i + 1))
    if (octal) {
      bytes.push(parseInt(octal[0], 8))
      i += 3
    } else if (next in SIMPLE_ESCAPES) {
      bytes.push(SIMPLE_ESCAPES[next] ?? 0)
      i += 1
    } else {
      bytes.push(92)
    }
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes))
}

// ---------------------------------------------------------------------------
// Commands

const EMPTY_STATUS = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] }

export async function gitStatus(projectPath: string): Promise<GitStatus> {
  const root = await resolveProjectRoot(projectPath)
  try {
    if (!(await isRepo(root))) return { gitAvailable: true, isRepo: false, ...EMPTY_STATUS }
    const result = await runGit(
      ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-b'],
      root,
    )
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || 'git status ist fehlgeschlagen.')
    }
    return { gitAvailable: true, isRepo: true, ...parseGitStatus(result.stdout) }
  } catch (error) {
    if (error instanceof GitMissingError) {
      return { gitAvailable: false, isRepo: false, ...EMPTY_STATUS }
    }
    throw error
  }
}

/** Unified diff of the working tree (or the index with `staged`), capped at DIFF_LIMIT. */
export async function gitDiff(
  projectPath: string,
  options: { path?: string | undefined; staged?: boolean | undefined } = {},
): Promise<string> {
  const root = await resolveProjectRoot(projectPath)
  if (!(await isRepo(root))) throw new Error(NOT_A_REPO_MESSAGE)
  const args = ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff']
  if (options.staged) args.push('--cached')
  if (options.path) args.push('--', topPathspec(options.path))
  const result = await runGit(args, root)
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'git diff ist fehlgeschlagen.')
  let diff = result.stdout
  if (!diff.trim() && options.path && !options.staged) {
    diff = await untrackedDiff(root, options.path)
  }
  return capDiff(diff, result.truncated)
}

/** Renders untracked files below `path` as "new file" diffs (git diff ignores them). */
async function untrackedDiff(root: string, path: string): Promise<string> {
  const listed = await runGit(
    ['ls-files', '--others', '--exclude-standard', '-z', '--', topPathspec(path)],
    root,
  )
  const files = listed.stdout.split('\0').filter(Boolean)
  if (files.length === 0) return ''
  const top = (await runGit(['rev-parse', '--show-toplevel'], root)).stdout.trim()
  const parts: string[] = []
  let total = 0
  for (const file of files.slice(0, UNTRACKED_DIFF_FILES)) {
    const abs = resolve(top, file)
    if (!isInsideOrSame(top, abs)) continue
    let content: Buffer
    try {
      content = await readFile(abs)
    } catch {
      continue
    }
    const part = newFileDiff(file, content)
    parts.push(part)
    total += part.length
    if (total > DIFF_LIMIT) break
  }
  if (files.length > UNTRACKED_DIFF_FILES) {
    parts.push(`… und ${files.length - UNTRACKED_DIFF_FILES} weitere neue Dateien\n`)
  }
  return parts.join('')
}

export function newFileDiff(file: string, content: Uint8Array): string {
  const header = `diff --git a/${file} b/${file}\nnew file mode 100644\n`
  if (isBinary(content.subarray(0, READ_FILE_LIMIT))) {
    return `${header}Binary files /dev/null and b/${file} differ\n`
  }
  const text = new TextDecoder('utf-8').decode(content.subarray(0, DIFF_LIMIT))
  if (text === '') return header
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const body = lines.map((l) => `+${l.endsWith('\r') ? l.slice(0, -1) : l}`).join('\n')
  const noEol = text.endsWith('\n') ? '' : '\n\\ No newline at end of file'
  return `${header}--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${body}${noEol}\n`
}

export function capDiff(diff: string, alreadyTruncated = false): string {
  if (diff.length <= DIFF_LIMIT && !alreadyTruncated) return diff
  const cut = diff.slice(0, DIFF_LIMIT)
  const lastNewline = cut.lastIndexOf('\n')
  const head = lastNewline > 0 ? cut.slice(0, lastNewline + 1) : cut
  return `${head}\n… Diff gekürzt (zu groß für die Anzeige)\n`
}

/** Commits (optionally staging everything first). Failures are reported, not thrown. */
export async function gitCommit(
  projectPath: string,
  message: string,
  stageAll: boolean,
): Promise<GitCommitResult> {
  const root = await resolveProjectRoot(projectPath)
  try {
    if (!(await isRepo(root))) return { ok: false, output: NOT_A_REPO_MESSAGE }
    const log: string[] = []
    if (stageAll) {
      const add = await runGit(['add', '-A'], root, 120_000)
      const addOutput = `${add.stdout}${add.stderr}`.trim()
      if (add.code !== 0) return { ok: false, output: addOutput || 'git add ist fehlgeschlagen.' }
      if (addOutput) log.push(addOutput)
    }
    const commit = await runGit(['commit', '-m', message], root, 120_000)
    const commitOutput = `${commit.stdout}${commit.stderr}`.trim()
    if (commitOutput) log.push(commitOutput)
    const output = log.join('\n')
    if (commit.code !== 0) return { ok: false, output: output || 'git commit ist fehlgeschlagen.' }
    return { ok: true, output }
  } catch (error) {
    if (error instanceof GitMissingError) return { ok: false, output: GIT_MISSING_MESSAGE }
    throw error
  }
}
