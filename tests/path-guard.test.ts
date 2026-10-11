import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  canonicalPath,
  checkToolAccess,
  isWithin,
  pathGuardHook,
  toolPaths,
  type GuardContext,
  type GuardDecision,
} from '../src/main/agent/path-guard'

const action = (d: GuardDecision) => d.action

describe('path guard (POSIX, real file system)', () => {
  let base: string
  let project: string
  let outside: string
  let attachments: string
  let ctx: GuardContext

  beforeAll(() => {
    // Real path, so macOS /var -> /private/var does not confuse the expectations.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'aiw-guard-')))
    project = join(base, 'projekt')
    outside = join(base, 'geheim')
    attachments = join(base, 'data', 'attachments')
    mkdirSync(join(project, 'src'), { recursive: true })
    mkdirSync(outside)
    mkdirSync(attachments, { recursive: true })
    writeFileSync(join(project, 'src', 'a.ts'), 'x')
    writeFileSync(join(outside, 'secret.txt'), 'geheim')
    writeFileSync(join(attachments, 'bild.png'), 'png')
    if (process.platform !== 'win32') {
      symlinkSync(outside, join(project, 'link-raus'))
      symlinkSync(join(outside, 'secret.txt'), join(project, 'secret-link.txt'))
      symlinkSync(project, join(base, 'projekt-link'))
    }
    ctx = {
      roots: { readWrite: [project], readOnly: [attachments] },
      cwd: project,
      home: join(base, 'home'),
    }
  })

  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('allows file tools inside the work folder', () => {
    expect(action(checkToolAccess('Read', { file_path: join(project, 'src', 'a.ts') }, ctx))).toBe(
      'allow',
    )
    expect(action(checkToolAccess('Write', { file_path: join(project, 'neu.txt') }, ctx))).toBe(
      'allow',
    )
    // New files in folders that do not exist yet.
    expect(
      action(checkToolAccess('Edit', { file_path: join(project, 'x', 'y', 'z.ts') }, ctx)),
    ).toBe('allow')
    // Relative paths resolve against the working directory.
    expect(action(checkToolAccess('Read', { file_path: 'src/a.ts' }, ctx))).toBe('allow')
    expect(action(checkToolAccess('Glob', { pattern: '**/*.ts' }, ctx))).toBe('allow')
    expect(action(checkToolAccess('Grep', { pattern: 'x' }, ctx))).toBe('allow')
  })

  it('denies paths outside, with a German reason', () => {
    const decision = checkToolAccess('Read', { file_path: join(outside, 'secret.txt') }, ctx)
    expect(decision).toMatchObject({ action: 'deny' })
    expect(decision.action === 'deny' && decision.reason).toMatch(
      /außerhalb des Arbeitsordners .*projekt/,
    )
    expect(action(checkToolAccess('Write', { file_path: '/etc/passwd' }, ctx))).toBe('deny')
    expect(action(checkToolAccess('Read', { file_path: '~/.ssh/id_rsa' }, ctx))).toBe('deny')
    expect(
      action(checkToolAccess('NotebookEdit', { notebook_path: join(outside, 'n.ipynb') }, ctx)),
    ).toBe('deny')
  })

  it('resolves .. before comparing', () => {
    expect(
      action(
        checkToolAccess('Read', { file_path: join(project, '..', 'geheim', 'secret.txt') }, ctx),
      ),
    ).toBe('deny')
    expect(action(checkToolAccess('Read', { file_path: '../geheim/secret.txt' }, ctx))).toBe('deny')
    expect(
      action(
        checkToolAccess('Read', { file_path: join(project, 'src', '..', 'src', 'a.ts') }, ctx),
      ),
    ).toBe('allow')
  })

  it('does not treat a folder with the same prefix as inside', () => {
    mkdirSync(`${project}2`, { recursive: true })
    expect(action(checkToolAccess('Read', { file_path: `${project}2/a.txt` }, ctx))).toBe('deny')
  })

  it.skipIf(process.platform === 'win32')('follows symlinks out of the folder', () => {
    expect(
      action(checkToolAccess('Read', { file_path: join(project, 'secret-link.txt') }, ctx)),
    ).toBe('deny')
    expect(
      action(checkToolAccess('Read', { file_path: join(project, 'link-raus', 'secret.txt') }, ctx)),
    ).toBe('deny')
    // New file below a symlinked folder that points outside.
    expect(
      action(checkToolAccess('Write', { file_path: join(project, 'link-raus', 'neu.txt') }, ctx)),
    ).toBe('deny')
    // A symlink to the project itself is the same folder.
    expect(
      action(
        checkToolAccess('Read', { file_path: join(base, 'projekt-link', 'src', 'a.ts') }, ctx),
      ),
    ).toBe('allow')
  })

  it('lets read-only roots be read but not changed', () => {
    const file = join(attachments, 'bild.png')
    expect(action(checkToolAccess('Read', { file_path: file }, ctx))).toBe('allow')
    const write = checkToolAccess('Write', { file_path: file }, ctx)
    expect(write).toMatchObject({ action: 'deny' })
    expect(write.action === 'deny' && write.reason).toMatch(/nur gelesen/)
  })

  it('asks before changing configuration that runs commands outside the sandbox', () => {
    for (const rel of [
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.mcp.json',
      '.git/config',
      '.git/hooks/pre-commit',
    ]) {
      expect(action(checkToolAccess('Write', { file_path: join(project, rel) }, ctx))).toBe('ask')
      expect(action(checkToolAccess('Read', { file_path: join(project, rel) }, ctx))).toBe('allow')
    }
    expect(
      action(
        checkToolAccess('Write', { file_path: join(project, '.claude', 'agents', 'a.md') }, ctx),
      ),
    ).toBe('allow')
    // "Alles erlauben" would approve an "ask" silently, so it is a deny there.
    const bypass = checkToolAccess(
      'Write',
      { file_path: join(project, '.mcp.json') },
      { ...ctx, permissionMode: 'bypassPermissions' },
    )
    expect(bypass).toMatchObject({ action: 'deny' })
    expect(bypass.action === 'deny' && bypass.reason).toMatch(/Alles erlauben/)
  })

  it('checks where glob patterns start searching', () => {
    expect(action(checkToolAccess('Glob', { pattern: `${outside}/**/*` }, ctx))).toBe('deny')
    expect(action(checkToolAccess('Glob', { pattern: '../geheim/*.txt' }, ctx))).toBe('deny')
    expect(action(checkToolAccess('Glob', { pattern: '/**/*.env' }, ctx))).toBe('deny')
    expect(action(checkToolAccess('Glob', { path: project, pattern: 'src/**' }, ctx))).toBe('allow')
    expect(
      action(
        checkToolAccess('Glob', { path: join(project, 'src'), pattern: '../../geheim/*' }, ctx),
      ),
    ).toBe('deny')
    expect(action(checkToolAccess('Grep', { path: outside, pattern: 'x' }, ctx))).toBe('deny')
    expect(action(checkToolAccess('LS', { path: base }, ctx))).toBe('deny')
  })

  it('ignores tools that are not file tools and refuses file tools without a path', () => {
    expect(action(checkToolAccess('Bash', { command: `cat ${outside}/secret.txt` }, ctx))).toBe(
      'allow',
    )
    expect(action(checkToolAccess('mcp__media__save_file', { path: '/etc/x' }, ctx))).toBe('allow')
    expect(action(checkToolAccess('Read', {}, ctx))).toBe('deny')
    expect(action(checkToolAccess('Read', { file_path: 'a\0b' }, ctx))).toBe('deny')
    expect(toolPaths('Bash', {})).toBeUndefined()
  })

  it('works as an in-process SDK hook', async () => {
    const hook = pathGuardHook({ roots: ctx.roots, home: join(base, 'home') })
    const callback = hook.hooks[0]
    if (!callback) throw new Error('no hook')
    const call = (tool_name: string, tool_input: unknown) =>
      callback(
        {
          hook_event_name: 'PreToolUse',
          tool_name,
          tool_input,
          tool_use_id: 't1',
          session_id: 's',
          transcript_path: '/t',
          cwd: project,
        } as Parameters<typeof callback>[0],
        't1',
        { signal: new AbortController().signal },
      )
    expect(await call('Read', { file_path: join(project, 'src', 'a.ts') })).toEqual({})
    expect(await call('Read', { file_path: join(outside, 'secret.txt') })).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('Von AI Workbench blockiert'),
      },
    })
    expect(await call('Write', { file_path: join(project, '.mcp.json') })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'ask' },
    })
  })
})

describe('path guard (Windows rules)', () => {
  const win = (roots: GuardContext['roots'], cwd = roots.readWrite[0] ?? 'C:\\'): GuardContext => ({
    roots,
    cwd,
    platform: 'win32',
    home: 'C:\\Users\\Max',
    realpath: (p) => p,
  })
  const ctx = win({
    readWrite: ['C:\\Projekte\\App'],
    readOnly: ['C:\\Users\\Max\\AppData\\aiw\\att'],
  })
  const check = (tool: string, path: string, c = ctx) =>
    action(checkToolAccess(tool, { file_path: path }, c))

  it('ignores case, drive-letter spelling and slash direction', () => {
    expect(check('Read', 'c:\\projekte\\app\\src\\a.ts')).toBe('allow')
    expect(check('Write', 'C:/Projekte/App/neu.txt')).toBe('allow')
    expect(check('Read', 'C:\\PROJEKTE\\APP')).toBe('allow')
    expect(check('Read', 'c:\\users\\max\\appdata\\aiw\\att\\x.png')).toBe('allow')
  })

  it('denies other drives, parents, siblings and the home folder', () => {
    expect(check('Read', 'D:\\Projekte\\App\\a.ts')).toBe('deny')
    expect(check('Read', 'C:\\Projekte\\App\\..\\Andere\\a.ts')).toBe('deny')
    expect(check('Read', 'C:\\Projekte\\App2\\a.ts')).toBe('deny')
    expect(check('Read', '..\\Andere\\a.ts')).toBe('deny')
    expect(check('Read', '~\\.ssh\\id_rsa')).toBe('deny')
    expect(check('Read', 'C:\\Users\\Max\\Documents\\x.docx')).toBe('deny')
    // Drive-relative path: resolved against the current directory of that drive.
    expect(check('Read', 'D:secret.txt')).toBe('deny')
  })

  it('handles UNC and long-path prefixes', () => {
    const unc = win({ readWrite: ['\\\\server\\share\\projekt'], readOnly: [] })
    expect(check('Read', '\\\\SERVER\\Share\\projekt\\a.ts', unc)).toBe('allow')
    expect(check('Read', '//server/share/projekt/a.ts', unc)).toBe('allow')
    expect(check('Read', '\\\\server\\share\\anderes\\a.ts', unc)).toBe('deny')
    expect(check('Read', '\\\\other\\share\\projekt\\a.ts', unc)).toBe('deny')
    expect(check('Read', 'C:\\Projekte\\App\\a.ts', unc)).toBe('deny')
    expect(check('Read', '\\\\server\\share\\projekt\\a.ts')).toBe('deny')
    expect(check('Read', '\\\\?\\C:\\Projekte\\App\\a.ts')).toBe('allow')
    expect(check('Read', '\\\\?\\C:\\Projekte\\App\\..\\x.ts')).toBe('deny')
    expect(check('Read', '\\\\?\\UNC\\server\\share\\projekt\\a.ts', unc)).toBe('allow')
    expect(check('Read', '\\\\.\\PhysicalDrive0')).toBe('deny')
  })

  it('protects configuration files regardless of case', () => {
    expect(check('Write', 'C:\\Projekte\\App\\.CLAUDE\\Settings.Local.json')).toBe('ask')
    expect(check('Edit', 'c:\\projekte\\app\\.git\\HOOKS\\pre-push')).toBe('ask')
  })

  it('compares with isWithin and canonicalPath', () => {
    expect(isWithin('C:\\a', 'c:\\A\\b', 'win32')).toBe(true)
    expect(isWithin('C:\\a', 'C:\\ab', 'win32')).toBe(false)
    expect(isWithin('/a', '/A/b', 'linux')).toBe(false)
    expect(isWithin('/a', '/a/..b', 'linux')).toBe(true)
    expect(canonicalPath('x\\..\\y', { cwd: 'C:\\p', platform: 'win32', realpath: (p) => p })).toBe(
      'C:\\p\\y',
    )
  })
})
