import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  SettingsSchema,
  type Settings,
  type SettingsPatch,
} from '@shared/schemas/settings'

/** Upgrades settings files written by older versions. */
export function migrateSettings(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const data = { ...(raw as Record<string, unknown>) }
  const version = typeof data['settingsVersion'] === 'number' ? data['settingsVersion'] : 1
  // v2: dark mode became the default; files from v1 always stored the old default "system".
  if (version < 2 && data['theme'] === 'system') data['theme'] = 'dark'
  data['settingsVersion'] = SETTINGS_VERSION
  return data
}

/** JSON-file backed settings, validated with Zod on every read and write. */
export class SettingsStore {
  private cache: Settings | undefined

  constructor(private readonly filePath: string) {}

  get(): Settings {
    if (this.cache) return this.cache
    let raw: unknown = {}
    try {
      raw = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch {
      // Missing or corrupt file: fall back to defaults.
    }
    const parsed = SettingsSchema.safeParse(migrateSettings(raw))
    this.cache = parsed.success ? parsed.data : DEFAULT_SETTINGS
    return this.cache
  }

  update(patch: SettingsPatch): Settings {
    const current = this.get()
    const next = SettingsSchema.parse({
      ...current,
      ...patch,
      models: { ...current.models, ...patch.models },
    })
    this.write(next)
    this.cache = next
    return next
  }

  private write(settings: Settings): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    // Write atomically so a crash never leaves a half-written file.
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8')
    renameSync(tmp, this.filePath)
  }
}
