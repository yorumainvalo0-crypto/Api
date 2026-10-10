import type { Settings } from '@shared/schemas/settings'
import type { SecretStore } from '../storage/secret-store'
import { JevClient } from './client'

export interface JevOverrides {
  endpoint?: string | undefined
  fetchImpl?: typeof fetch | undefined
}

/** Builds the Jev client from the settings, or explains (German) why it is unavailable. */
export function jevClientFromSettings(
  settings: Settings,
  secrets: SecretStore,
  overrides: JevOverrides = {},
): { client: JevClient } | { reason: string } {
  const source = settings.jevSource
  const apiKey = secrets.get(source === 'typesafe' ? 'typesafe' : 'openrouter')
  if (!apiKey) {
    return {
      reason:
        source === 'typesafe'
          ? 'Kein TypeSafe-API-Key gespeichert.'
          : 'Kein OpenRouter-API-Key gespeichert.',
    }
  }
  return {
    client: new JevClient({
      source,
      apiKey,
      model: settings.jevModel,
      endpoint: overrides.endpoint,
      fetchImpl: overrides.fetchImpl,
    }),
  }
}
