import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk'
import { GUARDED_TOOLS } from '../agent/path-guard'

/**
 * Per-session settings for `claude` in the terminal, passed with `--settings <file>` (the
 * runtime's highest user-controlled settings layer). They confine Claude Code to the terminal's
 * work folder:
 * - an HTTP PreToolUse hook on every file tool, answered by the app's path guard
 *   (see ./guard-server.ts); failures block the tool call,
 * - `disableAllHooks: false`, which overrides a `disableAllHooks` in the project's
 *   .claude/settings*.json (verified: otherwise a project file could switch the guard off),
 * - the OS sandbox for shell commands where it is available (see ../agent/sandbox.ts); its
 *   network proxy lets the hook reach the guard's host:port.
 */
export interface TerminalClaudeSettingsArgs {
  /** Hook URL of this session (guard server URL + session id). */
  guardUrl: string
  guardToken: string
  /** Sandbox block, undefined when the OS sandbox is not available. */
  sandbox?: SandboxSettings | undefined
}

export function buildTerminalClaudeSettings(
  args: TerminalClaudeSettingsArgs,
): Record<string, unknown> {
  // Verified: with the sandbox on, the runtime sends HTTP hooks through the sandbox's network
  // proxy, which refuses 127.0.0.1 unless that exact host:port is allowed.
  const sandbox = args.sandbox
    ? {
        ...args.sandbox,
        network: {
          ...args.sandbox.network,
          allowedDomains: [
            ...(args.sandbox.network?.allowedDomains ?? []),
            new URL(args.guardUrl).host,
          ],
        },
      }
    : undefined
  return {
    disableAllHooks: false,
    hooks: {
      PreToolUse: [
        {
          matcher: GUARDED_TOOLS.join('|'),
          hooks: [
            {
              type: 'http',
              url: args.guardUrl,
              headers: { Authorization: `Bearer ${args.guardToken}` },
              timeout: 30,
              onFailure: 'block',
            },
          ],
        },
      ],
    },
    ...(sandbox ? { sandbox } : {}),
  }
}

/** Folder with the per-session settings files (outside every work folder). */
export function sessionSettingsDir(dataDir: string): string {
  return join(dataDir, 'terminal', 'sessions')
}

/** Writes the settings of a session and returns the file path. */
export function writeSessionSettings(
  dir: string,
  sessionId: string,
  settings: Record<string, unknown>,
): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.json`)
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  return file
}

export function removeSessionSettings(dir: string, sessionId: string): void {
  rmSync(join(dir, `${sessionId}.json`), { force: true })
}
