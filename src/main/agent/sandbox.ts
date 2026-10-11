import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, posix, win32 } from 'node:path'
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk'
import type { AgentPermissionMode, SandboxStatus } from '@shared/schemas/permissions'
import type { ProviderId } from '@shared/schemas/settings'
import { isWithin } from './path-guard'

/**
 * Claude Code's OS sandbox for shell commands (Bash tool), verified against the bundled runtime:
 * - Linux/WSL2: bubblewrap + socat must be installed; then writes are limited to the work folder
 *   and denied read paths are invisible to commands.
 * - macOS: Seatbelt (sandbox-exec, built in).
 * - Windows: behind a feature gate that is off in this runtime version (it would also need Git
 *   Bash and a one-time `/sandbox install`). With `sandbox.enabled` the runtime only warns and
 *   runs commands unsandboxed, so the app does not enable it there and says so.
 */

export interface SandboxProbe {
  /** Finds an executable on PATH. */
  which: (name: string) => string | undefined
  /** Runs bubblewrap once to check that it works (user namespaces may be disabled). */
  bwrapWorks: (bwrap: string) => boolean
  exists: (path: string) => boolean
}

function whichOnPath(name: string, env: Record<string, string | undefined>): string | undefined {
  for (const dir of (env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    const file = posix.join(dir, name)
    if (existsSync(file)) return file
  }
  return undefined
}

function defaultProbe(env: Record<string, string | undefined>): SandboxProbe {
  return {
    which: (name) => whichOnPath(name, env),
    bwrapWorks: (bwrap) =>
      spawnSync(bwrap, ['--unshare-net', '--ro-bind', '/', '/', '--dev', '/dev', 'true'], {
        timeout: 5000,
        stdio: 'ignore',
      }).status === 0,
    exists: existsSync,
  }
}

const CONFINED =
  'Befehle dürfen nur im Arbeitsordner schreiben; das Home-Verzeichnis (außer dem Arbeitsordner) ' +
  'und externe Laufwerke sind für sie gesperrt, API-Keys aus ihrer Umgebung entfernt. ' +
  'Systemordner bleiben lesbar; Internetzugriffe von Befehlen schränkt die Sandbox ein.'

const NOT_CONFINED =
  'Befehle (Shell/Tests) laufen ohne Sandbox und sind NICHT auf den Arbeitsordner beschränkt; ' +
  'Lesen, Schreiben und Bearbeiten von Dateien bleibt auf den Ordner beschränkt.'

/** Whether the app can enable the sandbox on this computer (checked once per platform/env). */
export function detectSandbox(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  probe: SandboxProbe = defaultProbe(env),
): SandboxStatus {
  if (platform === 'linux') {
    const bwrap = probe.which('bwrap')
    const socat = probe.which('socat')
    if (!bwrap || !socat) {
      const missing = [bwrap ? null : 'bubblewrap', socat ? null : 'socat'].filter(Boolean)
      return {
        active: false,
        platform,
        summary:
          `Sandbox nicht aktiv: ${missing.join(' und ')} fehlt (z. B. „sudo apt install ` +
          `bubblewrap socat“, danach die App neu starten). ${NOT_CONFINED}`,
      }
    }
    if (!probe.bwrapWorks(bwrap)) {
      return {
        active: false,
        platform,
        summary: `Sandbox nicht aktiv: bubblewrap lässt sich nicht starten (Namespaces gesperrt?). ${NOT_CONFINED}`,
      }
    }
    return {
      active: true,
      platform,
      summary: `Sandbox aktiv (bubblewrap): ${CONFINED}`,
    }
  }
  if (platform === 'darwin') {
    return probe.exists('/usr/bin/sandbox-exec')
      ? {
          active: true,
          platform,
          summary: `Sandbox aktiv (macOS Seatbelt): ${CONFINED}`,
        }
      : {
          active: false,
          platform,
          summary: `Sandbox nicht aktiv: sandbox-exec fehlt. ${NOT_CONFINED}`,
        }
  }
  if (platform === 'win32') {
    return {
      active: false,
      platform,
      summary:
        'Unter Windows ist die Befehls-Sandbox von Claude Code in dieser Version nicht ' +
        `freigeschaltet (sie bräuchte außerdem Git Bash). ${NOT_CONFINED}`,
    }
  }
  return {
    active: false,
    platform,
    summary: `Sandbox auf ${platform} nicht unterstützt. ${NOT_CONFINED}`,
  }
}

let cached: SandboxStatus | undefined

/** detectSandbox() for this process, computed on first use. */
export function sandboxStatus(): SandboxStatus {
  cached ??= detectSandbox()
  return cached
}

export interface SandboxArgs {
  workFolder: string
  /** Extra folders commands may read (chat attachments, skills). */
  readRoots?: string[]
  /** PATH entries; tool folders inside the home directory stay readable (nvm, cargo, …). */
  pathDirs?: string[]
  /** Folders that must stay hidden even if they are on PATH (the app's data directory). */
  hidden?: string[]
  home?: string
  platform?: NodeJS.Platform
}

/** Tool installations inside the home directory that commands need to run (from PATH). */
export function toolchainDirs(
  pathDirs: string[],
  home: string,
  hidden: string[],
  platform: NodeJS.Platform,
): string[] {
  const api = platform === 'win32' ? win32 : posix
  const dirs = new Set<string>()
  for (const dir of pathDirs) {
    if (!api.isAbsolute(dir) || !isWithin(home, dir, platform)) continue
    if (hidden.some((h) => isWithin(h, dir, platform))) continue
    // The home directory itself never becomes readable (e.g. for ~/bin only that folder is).
    if (isWithin(dir, home, platform)) continue
    const base = api.basename(dir).toLowerCase()
    const parent = api.dirname(dir)
    const toolRoot = (base === 'bin' || base === 'scripts') && !isWithin(parent, home, platform)
    dirs.add(toolRoot ? parent : dir)
  }
  return [...dirs]
}

/**
 * Sandbox settings that confine shell commands to the work folder: writes only there, the home
 * directory (and external drives) hidden except the work folder and the given read roots, API
 * keys removed from the command environment, no way to run a command unsandboxed.
 */
export function buildSandboxSettings(args: SandboxArgs): SandboxSettings {
  const platform = args.platform ?? process.platform
  const api = platform === 'win32' ? win32 : posix
  const home = args.home ?? homedir()
  const extraDeny =
    platform === 'linux' ? ['/mnt', '/media'] : platform === 'darwin' ? ['/Volumes'] : []
  return {
    enabled: true,
    // If the runtime cannot sandbox after all, it must refuse to run instead of running unconfined.
    failIfUnavailable: true,
    // Commands still go through the chosen permission mode (asking, auto classifier, …).
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: [args.workFolder],
      denyWrite: [
        api.join(args.workFolder, '.git', 'hooks'),
        api.join(args.workFolder, '.git', 'config'),
      ],
      denyRead: [home, ...extraDeny],
      allowRead: [
        args.workFolder,
        ...(args.readRoots ?? []),
        ...toolchainDirs(args.pathDirs ?? [], home, args.hidden ?? [], platform),
        // git needs the user's name and e-mail for commits.
        api.join(home, '.gitconfig'),
        api.join(home, '.config', 'git'),
      ],
    },
    credentials: {
      envVars: [
        { name: 'ANTHROPIC_API_KEY', mode: 'deny' },
        { name: 'ANTHROPIC_AUTH_TOKEN', mode: 'deny' },
      ],
    },
  }
}

export interface EffectiveMode {
  mode: AgentPermissionMode
  /** Why the requested mode is not used, null when it is. */
  note: string | null
}

/**
 * Auto mode lets a classifier model approve each action. Verified against the bundled runtime:
 * the classifier always calls a Claude Sonnet model on the configured endpoint (default
 * `claude-sonnet-5`, overridable with ANTHROPIC_DEFAULT_SONNET_MODEL) and blocks every action it
 * cannot evaluate. Ollama has no such model, so auto mode would block all commands there; the
 * app uses "Dateiänderungen erlauben" instead.
 */
export function effectivePermissionMode(
  requested: AgentPermissionMode,
  provider: ProviderId,
): EffectiveMode {
  if (requested === 'auto' && provider === 'ollama') {
    return {
      mode: 'acceptEdits',
      note:
        '„Automatisch (KI prüft)“ braucht ein Claude-Prüfmodell (Anthropic oder OpenRouter). ' +
        'Mit Ollama gilt stattdessen „Dateiänderungen erlauben“: Befehle werden nachgefragt.',
    }
  }
  return { mode: requested, note: null }
}
