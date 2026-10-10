import { createRequire } from 'node:module'

/**
 * Resolves the platform-specific Claude Code runtime shipped by the Agent SDK.
 * In a packaged app the binary is unpacked next to the asar archive (see electron-builder.yml),
 * because executables cannot be spawned from inside an asar file.
 */
export function resolveClaudeExecutable(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  resolver: (id: string) => string = createRequire(import.meta.url).resolve,
): string {
  const binary = platform === 'win32' ? 'claude.exe' : 'claude'
  const resolved = resolver(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/${binary}`)
  return toUnpackedPath(resolved)
}

export function toUnpackedPath(path: string): string {
  return path.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}
