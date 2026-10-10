import type { ProviderId, Settings } from '@shared/schemas/settings'

export const OPENROUTER_ANTHROPIC_BASE_URL = 'https://openrouter.ai/api'

export class ProviderConfigError extends Error {
  override name = 'ProviderConfigError'
}

export interface ProviderRuntime {
  env: Record<string, string | undefined>
  model: string | undefined
}

export interface BuildProviderRuntimeArgs {
  provider: ProviderId
  settings: Settings
  /** API key for the provider, or undefined when none is stored. */
  secret: string | undefined
  /** Inherited process environment (PATH, HOME, ...). */
  baseEnv: Record<string, string | undefined>
  /** Isolated config directory so the agent never touches the user's own ~/.claude. */
  configDir: string
  appVersion: string
}

/**
 * Maps a provider selection to the environment the Claude Code runtime needs.
 * OpenRouter and Ollama expose Anthropic-compatible endpoints, so one agent core serves all three.
 */
export function buildProviderRuntime(args: BuildProviderRuntimeArgs): ProviderRuntime {
  const { provider, settings, secret, baseEnv, configDir, appVersion } = args

  // Drop inherited Anthropic credentials/endpoints so only the selected provider is used.
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!key.startsWith('ANTHROPIC_') && !key.startsWith('CLAUDE_')) env[key] = value
  }
  env['CLAUDE_CONFIG_DIR'] = configDir
  env['CLAUDE_AGENT_SDK_CLIENT_APP'] = `ai-workbench/${appVersion}`
  env['DISABLE_TELEMETRY'] = '1'
  env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'

  const selectedModel = settings.models[provider].trim() || undefined

  switch (provider) {
    case 'anthropic': {
      if (!secret) throw new ProviderConfigError('Kein Anthropic API-Key hinterlegt.')
      env['ANTHROPIC_API_KEY'] = secret
      return { env, model: selectedModel }
    }
    case 'openrouter': {
      if (!secret) throw new ProviderConfigError('Kein OpenRouter API-Key hinterlegt.')
      if (!selectedModel) throw new ProviderConfigError('Bitte ein OpenRouter-Modell auswählen.')
      env['ANTHROPIC_BASE_URL'] = OPENROUTER_ANTHROPIC_BASE_URL
      env['ANTHROPIC_AUTH_TOKEN'] = secret
      // Must be explicitly empty, otherwise the runtime prefers it over the auth token.
      env['ANTHROPIC_API_KEY'] = ''
      return { env, model: selectedModel }
    }
    case 'ollama': {
      if (!selectedModel) throw new ProviderConfigError('Bitte ein Ollama-Modell auswählen.')
      env['ANTHROPIC_BASE_URL'] = settings.ollamaBaseUrl.replace(/\/+$/, '')
      env['ANTHROPIC_AUTH_TOKEN'] = secret || 'ollama'
      env['ANTHROPIC_API_KEY'] = ''
      return { env, model: selectedModel }
    }
  }
}
