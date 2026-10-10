import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  type Settings,
  type SettingsPatch,
} from '@shared/schemas/settings'

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
    const parsed = SettingsSchema.safeParse(raw)
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
