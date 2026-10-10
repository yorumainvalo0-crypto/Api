import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/schemas/settings'
import {
  buildProviderRuntime,
  OPENROUTER_ANTHROPIC_BASE_URL,
  ProviderConfigError,
} from '../src/main/agent/providers'

const baseEnv = {
  PATH: '/usr/bin',
  ANTHROPIC_API_KEY: 'leaked-from-shell',
  ANTHROPIC_BASE_URL: 'https://evil.example',
  CLAUDE_CODE_USE_BEDROCK: '1',
}

function settingsWith(patch: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

const common = { baseEnv, configDir: '/tmp/cfg', appVersion: '0.1.0' }

describe('buildProviderRuntime', () => {
  it('uses the stored Anthropic key and strips inherited credentials', () => {
    const rt = buildProviderRuntime({
      ...common,
      provider: 'anthropic',
      settings: DEFAULT_SETTINGS,
      secret: 'sk-ant-test',
    })
    expect(rt.env['ANTHROPIC_API_KEY']).toBe('sk-ant-test')
    expect(rt.env['ANTHROPIC_BASE_URL']).toBeUndefined()
    expect(rt.env['CLAUDE_CODE_USE_BEDROCK']).toBeUndefined()
    expect(rt.env['PATH']).toBe('/usr/bin')
    expect(rt.env['CLAUDE_CONFIG_DIR']).toBe('/tmp/cfg')
    expect(rt.model).toBeUndefined()
  })

  it('fails without an Anthropic key', () => {
    expect(() =>
      buildProviderRuntime({
        ...common,
        provider: 'anthropic',
        settings: DEFAULT_SETTINGS,
        secret: undefined,
      }),
    ).toThrow(ProviderConfigError)
  })

  it('routes OpenRouter through its Anthropic-compatible endpoint', () => {
    const rt = buildProviderRuntime({
      ...common,
      provider: 'openrouter',
      settings: settingsWith({ models: { ...DEFAULT_SETTINGS.models, openrouter: 'anthropic/x' } }),
      secret: 'sk-or-test',
    })
    expect(rt.env['ANTHROPIC_BASE_URL']).toBe(OPENROUTER_ANTHROPIC_BASE_URL)
    expect(rt.env['ANTHROPIC_AUTH_TOKEN']).toBe('sk-or-test')
    expect(rt.env['ANTHROPIC_API_KEY']).toBe('')
    expect(rt.model).toBe('anthropic/x')
  })

  it('requires a model for OpenRouter', () => {
    expect(() =>
      buildProviderRuntime({
        ...common,
        provider: 'openrouter',
        settings: DEFAULT_SETTINGS,
        secret: 'k',
      }),
    ).toThrow(/Modell/)
  })

  it('points Ollama at the configured base URL without requiring a key', () => {
    const rt = buildProviderRuntime({
      ...common,
      provider: 'ollama',
      settings: settingsWith({
        ollamaBaseUrl: 'http://127.0.0.1:11434/',
        models: { ...DEFAULT_SETTINGS.models, ollama: 'qwen3:8b' },
      }),
      secret: undefined,
    })
    expect(rt.env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:11434')
    expect(rt.env['ANTHROPIC_AUTH_TOKEN']).toBe('ollama')
    expect(rt.model).toBe('qwen3:8b')
  })
})
