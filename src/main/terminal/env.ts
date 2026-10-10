import type { ProviderId, Settings } from '@shared/schemas/settings'
import { buildProviderRuntime, isolatedRuntimeEnv, ProviderConfigError } from '../agent/providers'
import { prependPath } from './shell'
import { WRAPPER_ENV } from './wrapper'

export interface TerminalEnvArgs {
  settings: Settings
  /** API key of the active provider, undefined when none is stored. */
  secret: string | undefined
  /** Inherited process environment. */
  baseEnv: Record<string, string | undefined>
  /** CLAUDE_CONFIG_DIR for `claude` (shared with the in-app agent, see ./service.ts). */
  configDir: string
  appVersion: string
  /** Folder with the generated `claude` wrapper; prepended to PATH. */
  binDir: string
  /** Bundled Claude Code runtime the wrapper starts. */
  claudeExecutable: string
  sessionId: string
  /** Local OTLP endpoint that receives token/cost events from `claude`. */
  usage?: { endpoint: string; token: string }
  platform?: NodeJS.Platform
}

export interface TerminalEnv {
  env: Record<string, string>
  provider: ProviderId
  /** Why the app's credentials are not available to `claude`, null when they are. */
  notice: string | null
}

/** Inherited variables that would misconfigure the shell or the programs started in it. */
const DROPPED = [
  /^OTEL_/,
  /^TERM_PROGRAM/,
  /^ELECTRON_RUN_AS_NODE$/,
  /^ELECTRON_NO_ATTACH_CONSOLE$/,
]

/**
 * Environment of a terminal session: the user's environment plus everything `claude` needs to
 * use the active provider (the same variables the in-app agent gets), the selected model and
 * reasoning effort, and the wrapper folder on PATH.
 */
export function buildTerminalEnv(args: TerminalEnvArgs): TerminalEnv {
  const { settings, secret, baseEnv, configDir, appVersion, binDir, sessionId, usage } = args
  const { claudeExecutable } = args
  const platform = args.platform ?? process.platform
  const provider = settings.activeProvider

  let raw: Record<string, string | undefined>
  let notice: string | null = null
  try {
    const runtime = buildProviderRuntime({
      provider,
      settings,
      secret,
      baseEnv,
      configDir,
      appVersion,
    })
    raw = runtime.env
    // Default model for the session; `claude --model` and /model still override it.
    if (runtime.model) raw['ANTHROPIC_MODEL'] = runtime.model
    // Verified against the bundled runtime: sets output_config.effort of every request.
    // Local Ollama models do not understand the effort parameter (same rule as the chat).
    if (settings.effort !== 'default' && provider !== 'ollama') {
      raw['CLAUDE_CODE_EFFORT_LEVEL'] = settings.effort
    }
  } catch (error) {
    if (!(error instanceof ProviderConfigError)) throw error
    raw = isolatedRuntimeEnv(baseEnv, configDir, appVersion)
    notice = `${error.message} Claude Code nutzt dann keine Zugangsdaten der App.`
  }

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && !DROPPED.some((pattern) => pattern.test(key))) env[key] = value
  }
  env['COLORTERM'] = 'truecolor'
  if (platform !== 'win32') {
    env['TERM'] = 'xterm-256color'
    // Apps started from a desktop launcher often have no locale, which breaks umlauts.
    if (!env['LANG'] && !env['LC_ALL']) {
      env['LANG'] = platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
    }
  }
  env[WRAPPER_ENV.claude] = claudeExecutable
  env[WRAPPER_ENV.session] = sessionId
  if (usage) {
    env[WRAPPER_ENV.endpoint] = usage.endpoint
    env[WRAPPER_ENV.token] = usage.token
  }
  prependPath(env, binDir, platform)
  return { env, provider, notice }
}
