import { randomUUID } from 'node:crypto'
import type {
  CanUseTool,
  HookCallbackMatcher,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, PermissionDecision } from '@shared/schemas/agent'

/** Paths whose recursive deletion is never acceptable (root, home, system folders, drives). */
const PROTECTED_UNIX_TARGET =
  /^(\/|\/\*|~|~\/|~\/\*|\$\{?HOME\}?\/?\*?|\/(bin|boot|dev|etc|home|lib|lib64|opt|root|sbin|srv|usr|var|Users|System|Library)\/?\*?)$/
const PROTECTED_WINDOWS_TARGET =
  /^["']?([a-z]:\\?\*?|[a-z]:\\(windows|users|program files( \(x86\))?)\\?\*?|\$env:(userprofile|systemroot|windir|systemdrive|homedrive)\\?\*?|~\\?\*?|\$home\\?\*?)["']?$/i

/** Patterns matched against the whole command line. */
const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bformat(-volume)?\s+([a-z]:|-driveletter)/i, reason: 'Formatieren eines Laufwerks' },
  { pattern: /\bmkfs(\.\w+)?\s/i, reason: 'Formatieren eines Dateisystems' },
  {
    pattern: /\bdd\s+[^|;]*\bof=\/dev\/(sd|nvme|hd|disk|mmcblk)/i,
    reason: 'Direktes Überschreiben einer Festplatte',
  },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};\s*:/, reason: 'Fork-Bombe' },
  {
    pattern: /\bdiskpart\b|\bbcdedit\b|\breg\s+delete\s+hk(lm|ey_local_machine)/i,
    reason: 'Eingriff in System-/Bootkonfiguration',
  },
]

const POWER_COMMANDS = new Set([
  'shutdown',
  'reboot',
  'poweroff',
  'halt',
  'stop-computer',
  'restart-computer',
])

/** Splits a command line into simple commands (pipes, &&, ||, ;, newlines). */
function segments(command: string): string[][] {
  return command
    .split(/[;&|\n]+/)
    .map((part) => part.trim().split(/\s+/).filter(Boolean))
    .map((tokens) => (tokens[0] === 'sudo' ? tokens.slice(1) : tokens))
    .filter((tokens) => tokens.length > 0)
}

function checkSegment(tokens: string[]): string | undefined {
  const [program = '', ...args] = tokens
  const name = program.toLowerCase().replace(/\.exe$/, '')
  const flags = args.filter((a) => a.startsWith('-') || a.startsWith('/'))
  const targets = args.filter((a) => !a.startsWith('-'))

  if (POWER_COMMANDS.has(name)) return 'Herunterfahren oder Neustarten'

  if (name === 'rm') {
    const recursive = flags.some((f) => /^-[a-z]*r/i.test(f) || f === '--recursive')
    if (recursive && targets.some((t) => PROTECTED_UNIX_TARGET.test(t))) {
      return 'Rekursives Löschen von System-, Home- oder Wurzelverzeichnis'
    }
  }

  if (['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir'].includes(name)) {
    const recursive = flags.some((f) => /^(-recurse|-r|\/s)$/i.test(f))
    const winTargets = args.filter((a) => !/^-|^\/[a-z]$/i.test(a))
    if (recursive && winTargets.some((t) => PROTECTED_WINDOWS_TARGET.test(t))) {
      return 'Rekursives Löschen eines Laufwerks, System- oder Benutzerordners'
    }
  }
  return undefined
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

/** Returns a German reason if the shell command must never run, otherwise undefined. */
export function findDangerousCommand(command: string): string | undefined {
  const byPattern = DANGEROUS_PATTERNS.find((d) => d.pattern.test(command))?.reason
  if (byPattern) return byPattern
  for (const tokens of segments(command)) {
    const reason = checkSegment(tokens)
    if (reason) return reason
  }
  return undefined
}

/** PreToolUse hook that blocks dangerous shell commands regardless of the permission mode. */
export function dangerousCommandHook(): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== 'PreToolUse' || !SHELL_TOOLS.has(input.tool_name)) return {}
        const command = (input.tool_input as { command?: unknown } | null)?.command
        const reason = typeof command === 'string' ? findDangerousCommand(command) : undefined
        if (!reason) return {}
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Von AI Workbench blockiert: ${reason}.`,
          },
        }
      },
    ],
  }
}

interface PendingRequest {
  chatId: string
  resolve: (result: PermissionResult) => void
  suggestions: Parameters<CanUseTool>[2]['suggestions']
}

/**
 * Bridges the SDK's canUseTool callback to the UI: emits a permission-request event and waits
 * for the user's decision (or the run being aborted).
 */
export class PermissionBroker {
  private readonly pending = new Map<string, PendingRequest>()

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  canUseTool(chatId: string): CanUseTool {
    return (toolName, input, options) =>
      new Promise<PermissionResult>((resolve) => {
        const requestId = randomUUID()
        const finish = (result: PermissionResult) => {
          if (!this.pending.delete(requestId)) return
          this.emit({ chatId, type: 'permission-resolved', requestId })
          resolve(result)
        }
        this.pending.set(requestId, { chatId, resolve: finish, suggestions: options.suggestions })
        options.signal.addEventListener('abort', () =>
          finish({ behavior: 'deny', message: 'Abgebrochen.', interrupt: true }),
        )
        this.emit({
          chatId,
          type: 'permission-request',
          requestId,
          toolName,
          input,
          title: options.title ?? null,
          description: options.description ?? options.decisionReason ?? null,
          blockedPath: options.blockedPath ?? null,
        })
      })
  }

  respond(requestId: string, decision: PermissionDecision, message?: string): boolean {
    const request = this.pending.get(requestId)
    if (!request) return false
    if (decision === 'deny') {
      request.resolve({ behavior: 'deny', message: message || 'Vom Nutzer abgelehnt.' })
    } else {
      request.resolve({
        behavior: 'allow',
        ...(decision === 'allow-always' && request.suggestions
          ? { updatedPermissions: request.suggestions }
          : {}),
      })
    }
    return true
  }

  /** Denies all open requests of a chat (e.g. when it is cancelled or deleted). */
  denyAll(chatId: string): void {
    for (const [id, request] of this.pending) {
      if (request.chatId === chatId) this.respond(id, 'deny', 'Abgebrochen.')
    }
  }

  pendingCount(): number {
    return this.pending.size
  }
}
