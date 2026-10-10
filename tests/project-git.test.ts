import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  capDiff,
  DIFF_LIMIT,
  gitCommit,
  gitDiff,
  gitStatus,
  newFileDiff,
  parseGitStatus,
  unquotePath,
} from '../src/main/project/git'

describe('parseGitStatus', () => {
  it('parses branch, tracking info and file states', () => {
    const output = [
      '## main...origin/main [ahead 2, behind 1]',
      ' M src/app.ts',
      'M  staged.ts',
      'MM both.ts',
      'A  new.ts',
      ' D gone.ts',
      'R  old name.ts -> new name.ts',
      'UU conflict.ts',
      'AA both-added.ts',
      '?? notes/',
      '?? "tab\\there.txt"',
      '?? "\\303\\244rger.txt"',
      '!! ignored.log',
      '',
    ].join('\n')
    const status = parseGitStatus(output)
    expect(status).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 })
    expect(status.files).toEqual([
      { path: 'src/app.ts', origPath: null, status: 'modified', staged: false },
      { path: 'staged.ts', origPath: null, status: 'modified', staged: true },
      { path: 'both.ts', origPath: null, status: 'modified', staged: true },
      { path: 'both.ts', origPath: null, status: 'modified', staged: false },
      { path: 'new.ts', origPath: null, status: 'added', staged: true },
      { path: 'gone.ts', origPath: null, status: 'deleted', staged: false },
      { path: 'new name.ts', origPath: 'old name.ts', status: 'renamed', staged: true },
      { path: 'conflict.ts', origPath: null, status: 'conflicted', staged: false },
      { path: 'both-added.ts', origPath: null, status: 'conflicted', staged: false },
      { path: 'notes/', origPath: null, status: 'untracked', staged: false },
      { path: 'tab\there.txt', origPath: null, status: 'untracked', staged: false },
      { path: 'ärger.txt', origPath: null, status: 'untracked', staged: false },
    ])
  })

  it('handles branch line variants', () => {
    expect(parseGitStatus('## main\n')).toMatchObject({ branch: 'main', upstream: null, ahead: 0 })
    expect(parseGitStatus('## No commits yet on master\n')).toMatchObject({ branch: 'master' })
    expect(parseGitStatus('## Initial commit on dev\n')).toMatchObject({ branch: 'dev' })
    expect(parseGitStatus('## HEAD (no branch)\n')).toMatchObject({ branch: null })
    expect(parseGitStatus('## feat/x...origin/feat/x [gone]\n')).toMatchObject({
      branch: 'feat/x',
      upstream: 'origin/feat/x',
      ahead: 0,
      behind: 0,
    })
    expect(parseGitStatus('## main...origin/main [behind 3]\r\n M a.ts\r\n')).toMatchObject({
      behind: 3,
      files: [{ path: 'a.ts', status: 'modified' }],
    })
  })

  it('parses quoted renames', () => {
    const status = parseGitStatus('R  "a\\"b.txt" -> "c d\\303\\274.txt"\n')
    expect(status.files).toEqual([
      { path: 'c dü.txt', origPath: 'a"b.txt', status: 'renamed', staged: true },
    ])
  })

  it('leaves unquoted paths alone', () => {
    expect(unquotePath('plain.txt')).toBe('plain.txt')
    expect(unquotePath('"a\\\\b"')).toBe('a\\b')
  })
})

describe('diff helpers', () => {
  it('renders new files as all-added', () => {
    const diff = newFileDiff('a.txt', new TextEncoder().encode('eins\nzwei\n'))
    expect(diff).toContain('--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+eins\n+zwei\n')
    expect(newFileDiff('b.bin', new Uint8Array([0, 1]))).toContain('Binary files')
  })

  it('caps large diffs', () => {
    const capped = capDiff('+x\n'.repeat(DIFF_LIMIT))
    expect(capped.length).toBeLessThan(DIFF_LIMIT + 100)
    expect(capped).toMatch(/Diff gekürzt/)
  })
})

describe('git commands on a real repository', () => {
  let repo: string
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'aiw-git-'))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('reports a non-repository gracefully', async () => {
    const status = await gitStatus(repo)
    expect(status).toMatchObject({ gitAvailable: true, isRepo: false, files: [] })
    await expect(gitDiff(repo)).rejects.toThrow(/kein Git-Repository/)
    expect(await gitCommit(repo, 'x', true)).toEqual({
      ok: false,
      output: 'Dieser Ordner ist kein Git-Repository.',
    })
  })

  it('shows status, commits and diffs', async () => {
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    git('config', 'commit.gpgsign', 'false')
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src', 'hello.txt'), 'hallo\n')

    let status = await gitStatus(repo)
    expect(status).toMatchObject({ gitAvailable: true, isRepo: true, branch: 'main' })
    expect(status.files).toEqual([
      { path: 'src/', origPath: null, status: 'untracked', staged: false },
    ])

    // Untracked files are rendered as additions.
    const untracked = await gitDiff(repo, { path: 'src/' })
    expect(untracked).toContain('+++ b/src/hello.txt')
    expect(untracked).toContain('+hallo')

    const commit = await gitCommit(repo, 'Erster Commit', true)
    expect(commit.ok).toBe(true)
    expect(git('log', '--format=%s')).toBe('Erster Commit\n')
    expect((await gitStatus(repo)).files).toEqual([])

    writeFileSync(join(repo, 'src', 'hello.txt'), 'hallo welt\n')
    status = await gitStatus(repo)
    expect(status.files).toEqual([
      { path: 'src/hello.txt', origPath: null, status: 'modified', staged: false },
    ])
    const diff = await gitDiff(repo, { path: 'src/hello.txt' })
    expect(diff).toContain('-hallo\n+hallo welt')
    expect(await gitDiff(repo, { path: 'src/hello.txt', staged: true })).toBe('')

    // Diff paths are repository-relative even when the project is a subfolder.
    const sub = join(repo, 'src')
    expect((await gitStatus(sub)).files[0]?.path).toBe('src/hello.txt')
    expect(await gitDiff(sub, { path: 'src/hello.txt' })).toContain('+hallo welt')

    git('add', '-A')
    expect((await gitStatus(repo)).files[0]).toMatchObject({ staged: true })
    expect(await gitDiff(repo, { staged: true })).toContain('+hallo welt')

    const empty = await gitCommit(repo, 'Zweiter', false)
    expect(empty.ok).toBe(true)
    const nothing = await gitCommit(repo, 'Nichts', true)
    expect(nothing.ok).toBe(false)
    expect(nothing.output).not.toBe('')
  })
})
