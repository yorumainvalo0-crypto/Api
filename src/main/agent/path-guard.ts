import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'

/**
 * Deterministic confinement of Claude Code's file tools to the selected work folder.
 *
 * Every file tool call (Read, Write, Edit, …) is checked before it runs: the target path is made
 * absolute, `~` and `..` are resolved, symlinks/junctions are followed (for paths that do not
 * exist yet: the deepest existing parent) and the result must lie inside an allowed root. On
 * Windows the comparison ignores case and drive-letter spelling and handles UNC and `\\?\` paths.
 * Used as an in-process hook by the coding chat and over HTTP by `claude` in the terminal.
 */

export interface GuardRoots {
  /** Folders Claude may read and change (the work folder). */
  readWrite: string[]
  /** Folders Claude may only read (chat attachments, installed skills and plugins). */
  readOnly: string[]
}

export interface GuardContext {
  roots: GuardRoots
  /** Directory relative paths are resolved against (the session's working directory). */
  cwd: string
  platform?: NodeJS.Platform
  home?: string
  /** Resolves symlinks of an existing path; throws when it does not exist (tests inject one). */
  realpath?: (path: string) => string
  /** Current permission mode of the session (from the hook input). */
  permissionMode?: string | undefined
}

export type GuardDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  /** The user has to confirm (protected configuration inside the work folder). */
  | { action: 'ask'; reason: string }

type Access = 'read' | 'write'

/**
 * File tools of the bundled runtime and the input keys holding their paths. The runtime of this
 * app version exposes Read, Write, Edit and NotebookEdit (search runs through Bash); the others
 * are listed so older/newer runtimes stay covered.
 */
const FILE_TOOLS: Record<string, { access: Access; keys: string[]; defaultsToCwd?: boolean }> = {
  Read: { access: 'read', keys: ['file_path'] },
  NotebookRead: { access: 'read', keys: ['notebook_path'] },
  Glob: { access: 'read', keys: ['path', 'pattern'], defaultsToCwd: true },
  Grep: { access: 'read', keys: ['path'], defaultsToCwd: true },
  LS: { access: 'read', keys: ['path'], defaultsToCwd: true },
  LSP: { access: 'read', keys: ['filePath', 'file_path', 'path'] },
  Write: { access: 'write', keys: ['file_path'] },
  Edit: { access: 'write', keys: ['file_path'] },
  MultiEdit: { access: 'write', keys: ['file_path'] },
  NotebookEdit: { access: 'write', keys: ['notebook_path', 'file_path'] },
}

/** Tool names the guard checks; the terminal's hook matcher is built from it. */
export const GUARDED_TOOLS = Object.keys(FILE_TOOLS)

/**
 * Files inside the work folder that make other programs run commands outside the sandbox
 * (Claude Code settings with hooks/apiKeyHelper, MCP server definitions, git hooks and config).
 * Changing them needs the user's confirmation, also in "Alles erlauben" and "Automatisch".
 */
const PROTECTED_FILES = [
  ['.claude', 'settings.json'],
  ['.claude', 'settings.local.json'],
  ['.mcp.json'],
  ['.git', 'config'],
  ['.git', 'hooks'],
]

/** The path module and comparison rules of a platform. */
function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix
}

function defaultRealpath(platform: NodeJS.Platform): (path: string) => string {
  // Following links is only possible for paths of the running OS.
  return platform === process.platform ? (p) => realpathSync.native(p) : (p) => p
}

/** Removes Windows long-path prefixes; returns undefined for device paths (`\\.\…`). */
function stripWindowsPrefix(path: string): string | undefined {
  const p = path.replace(/\//g, '\\')
  if (/^\\\\\?\\UNC\\/i.test(p)) return `\\\\${p.slice(8)}`
  if (/^\\\\\?\\/.test(p)) return p.slice(4)
  if (/^\\\\\.\\/.test(p)) return undefined
  return path
}

/**
 * Absolute, normalized path with symlinks resolved, or undefined when it cannot be judged
 * (device paths, empty input). Missing trailing segments are kept as they are.
 */
export function canonicalPath(
  path: string,
  context: Pick<GuardContext, 'cwd' | 'platform' | 'home' | 'realpath'>,
): string | undefined {
  const platform = context.platform ?? process.platform
  const api = pathApi(platform)
  const realpath = context.realpath ?? defaultRealpath(platform)
  let raw = path.trim()
  if (!raw || raw.includes('\0')) return undefined
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    raw = api.join(context.home ?? homedir(), raw.slice(1))
  }
  if (platform === 'win32') {
    const stripped = stripWindowsPrefix(raw)
    if (stripped === undefined) return undefined
    raw = stripped
  }
  const absolute = api.resolve(context.cwd, raw)

  // Follow links of the deepest part that exists; append the rest unchanged.
  const missing: string[] = []
  let current = absolute
  for (;;) {
    try {
      const real = realpath(current)
      return missing.length > 0 ? api.join(real, ...missing.reverse()) : real
    } catch {
      const parent = api.dirname(current)
      if (parent === current) return absolute
      missing.push(api.basename(current))
      current = parent
    }
  }
}

/** Comparison key: Windows paths ignore case and use backslashes. */
function compareKey(path: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return path
  const p = path.replace(/\//g, '\\').toLowerCase()
  return p.length > 3 && p.endsWith('\\') ? p.slice(0, -1) : p
}

/** True if `target` is `root` itself or lies below it (both canonical). */
export function isWithin(root: string, target: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform)
  const rel = api.relative(compareKey(root, platform), compareKey(target, platform))
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel)
}

/** Part of a glob pattern before the first wildcard (the directory it starts searching in). */
function globBase(pattern: string): string {
  const parts = pattern.split(/[\\/]/)
  const index = parts.findIndex((part) => /[*?[\]{}]/.test(part))
  if (index === -1) return pattern
  const base = parts.slice(0, index).join('/')
  return base === '' && pattern.startsWith('/') ? '/' : base || '.'
}

/** A path a tool call touches; `base` is the directory a relative `path` starts from. */
export interface TouchedPath {
  path: string
  base?: string
}

/** Paths a tool call touches, or undefined if the tool is not a file tool. */
export function toolPaths(
  toolName: string,
  input: unknown,
): { access: Access; paths: TouchedPath[] } | undefined {
  const spec = FILE_TOOLS[toolName]
  if (!spec) return undefined
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const value = (key: string) => {
    const v = record[key]
    return typeof v === 'string' && v.trim() ? v : undefined
  }
  const paths: TouchedPath[] = []
  for (const key of spec.keys) {
    const v = value(key)
    if (!v) continue
    if (toolName === 'Glob' && key === 'pattern') {
      // A relative pattern is matched below `path` (or the working directory).
      const base = value('path')
      paths.push(base ? { path: globBase(v), base } : { path: globBase(v) })
    } else {
      paths.push({ path: v })
    }
  }
  if (paths.length === 0 && spec.defaultsToCwd) paths.push({ path: '.' })
  return { access: spec.access, paths }
}

/** Canonical roots (computed once per guard; roots may not exist yet). */
function canonicalRoots(context: GuardContext): { readWrite: string[]; readOnly: string[] } {
  const canon = (list: string[]) =>
    list.flatMap((root) => {
      const c = canonicalPath(root, { ...context, cwd: root })
      return c ? [c] : []
    })
  return { readWrite: canon(context.roots.readWrite), readOnly: canon(context.roots.readOnly) }
}

function isProtected(root: string, target: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform)
  return PROTECTED_FILES.some((segments) => isWithin(api.join(root, ...segments), target, platform))
}

/**
 * Decides whether a tool call may run. Tools that are not file tools are allowed (shell
 * commands are confined by the OS sandbox, MCP tools check their own paths).
 */
export function checkToolAccess(
  toolName: string,
  input: unknown,
  context: GuardContext,
  roots = canonicalRoots(context),
): GuardDecision {
  const touched = toolPaths(toolName, input)
  if (!touched) return { action: 'allow' }
  const platform = context.platform ?? process.platform
  const workFolder = context.roots.readWrite[0] ?? '(keiner)'
  if (touched.paths.length === 0) {
    return { action: 'deny', reason: `Von AI Workbench blockiert: ${toolName} ohne Pfadangabe.` }
  }
  for (const { path, base } of touched.paths) {
    const cwd = base ? canonicalPath(base, context) : context.cwd
    const target = cwd ? canonicalPath(path, { ...context, cwd }) : undefined
    if (!target) {
      return {
        action: 'deny',
        reason: `Von AI Workbench blockiert: Der Pfad „${path}“ ist nicht erlaubt.`,
      }
    }
    const writable = roots.readWrite.find((root) => isWithin(root, target, platform))
    if (writable) {
      if (touched.access === 'write' && isProtected(writable, target, platform)) {
        const why =
          `„${target}“ ist eine geschützte Konfigurationsdatei (sie kann Befehle außerhalb der ` +
          'Sandbox starten).'
        // Verified: with bypassPermissions the runtime approves an "ask" without asking anyone.
        return context.permissionMode === 'bypassPermissions'
          ? {
              action: 'deny',
              reason:
                `Von AI Workbench blockiert: ${why} Im Modus „Alles erlauben“ ist die Änderung ` +
                'gesperrt; der Nutzer kann sie selbst vornehmen oder einen anderen Modus wählen.',
            }
          : { action: 'ask', reason: `${why} Änderung nur nach Bestätigung durch den Nutzer.` }
      }
      continue
    }
    const readable = roots.readOnly.some((root) => isWithin(root, target, platform))
    if (readable && touched.access === 'read') continue
    return {
      action: 'deny',
      reason: readable
        ? `Von AI Workbench blockiert: „${target}“ darf nur gelesen werden. ` +
          `Änderungen sind nur im Arbeitsordner ${workFolder} erlaubt.`
        : `Von AI Workbench blockiert: „${target}“ liegt außerhalb des Arbeitsordners ` +
          `${workFolder}. Claude darf nur im gewählten Arbeitsordner lesen und schreiben.`,
    }
  }
  return { action: 'allow' }
}

/** Hook output for a PreToolUse decision (shared by the SDK hook and the terminal's HTTP hook). */
export function hookOutput(decision: GuardDecision): Record<string, unknown> {
  if (decision.action === 'allow') return {}
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.action,
      permissionDecisionReason: decision.reason,
    },
  }
}

/** In-process PreToolUse hook for the Agent SDK (coding chat and its Cowork subagents). */
export function pathGuardHook(context: Omit<GuardContext, 'cwd'>): HookCallbackMatcher {
  const roots = canonicalRoots({ ...context, cwd: context.roots.readWrite[0] ?? '/' })
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return {}
        const decision = checkToolAccess(
          input.tool_name,
          input.tool_input,
          {
            ...context,
            cwd: input.cwd || context.roots.readWrite[0] || '/',
            permissionMode: input.permission_mode,
          },
          roots,
        )
        return hookOutput(decision)
      },
    ],
  }
}
