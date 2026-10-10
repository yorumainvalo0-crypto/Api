import { existsSync } from 'node:fs'
import { isAbsolute, join, win32 } from 'node:path'

export interface ShellSpec {
  file: string
  args: string[]
}

/** Value of an environment variable; Windows names are case-insensitive (`Path` vs `PATH`). */
export function envValue(
  env: Record<string, string | undefined>,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') return env[name]
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : env[key]
}

/**
 * The interactive shell for a terminal: PowerShell 7 (`pwsh`) if installed, else Windows
 * PowerShell on Windows; the user's $SHELL (or bash, or sh) elsewhere.
 */
export function defaultShell(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
): ShellSpec {
  if (platform === 'win32') {
    const pathDirs = (envValue(env, 'PATH', platform) ?? '').split(';').filter(Boolean)
    const pwsh = pathDirs.map((dir) => win32.join(dir, 'pwsh.exe')).find((file) => exists(file))
    // Keeps the user's profile; only switches the console to UTF-8 so umlauts survive.
    const args = [
      '-NoLogo',
      '-NoExit',
      '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8',
    ]
    return { file: pwsh ?? 'powershell.exe', args }
  }
  const shell = env['SHELL']
  const file =
    shell && isAbsolute(shell) && exists(shell)
      ? shell
      : exists('/bin/bash')
        ? '/bin/bash'
        : '/bin/sh'
  // macOS terminals start login shells so the profile (PATH from Homebrew etc.) is loaded.
  return { file, args: platform === 'darwin' ? ['-l'] : [] }
}

/** Prepends `dir` to PATH, keeping the variable's existing spelling on Windows. */
export function prependPath(
  env: Record<string, string>,
  dir: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const key =
    platform === 'win32'
      ? (Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path')
      : 'PATH'
  const separator = platform === 'win32' ? ';' : ':'
  const current = env[key]
  env[key] = current ? `${dir}${separator}${current}` : dir
}

/** Folder with the generated `claude` wrapper inside the app data dir. */
export function terminalBinDir(dataDir: string): string {
  return join(dataDir, 'terminal', 'bin')
}
