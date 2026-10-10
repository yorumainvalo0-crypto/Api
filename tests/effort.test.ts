import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsPatchSchema } from '@shared/schemas/settings'
import { effortOption } from '../src/main/agent/session-manager'

describe('effort setting', () => {
  it('is sent for Claude providers and left out for "default" and Ollama', () => {
    expect(DEFAULT_SETTINGS.effort).toBe('default')
    expect(effortOption({ effort: 'default' }, 'anthropic')).toEqual({})
    expect(effortOption({ effort: 'high' }, 'anthropic')).toEqual({ effort: 'high' })
    expect(effortOption({ effort: 'max' }, 'openrouter')).toEqual({ effort: 'max' })
    expect(effortOption({ effort: 'high' }, 'ollama')).toEqual({})
  })

  it('accepts only known levels from the renderer', () => {
    expect(SettingsPatchSchema.parse({ effort: 'xhigh' })).toEqual({ effort: 'xhigh' })
    expect(SettingsPatchSchema.safeParse({ effort: 'ultra' }).success).toBe(false)
  })
})
