import { describe, expect, it } from 'vitest'
import { describeAppCapabilities, type AppCapabilities } from '../src/main/agent/app-context'

const base: AppCapabilities = {
  mode: 'chat',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  effort: 'high',
  webAccess: true,
  image: { backend: 'openrouter', ready: true, model: 'google/gemini-3.1-flash-lite-image' },
  workflows3d: [],
  ocr: { enabled: false, model: 'qwen3-vl:8b-instruct' },
  jev: { active: true, source: 'typesafe' },
  skills: [],
  plugins: 0,
  mcpServers: [],
}

describe('app capabilities in the system prompt', () => {
  it('tells the model that Jev is available and what it is for', () => {
    const text = describeAppCapabilities(base)
    expect(text).toContain(
      'Jev von TypeSafe AI** (Werkzeug mcp__jev__evaluate, über TypeSafe direkt) – aktiv',
    )
    expect(text).toContain('choice')
    expect(text).toContain('Modell claude-opus-5-5, Effort Hoch, Modus Chat')
    expect(text).toContain(
      'Handschrift/Scans lokal lesen mit read_handwriting (Ollama, qwen3-vl:8b-instruct) – NICHT aktiv',
    )
    expect(text).toContain('„Verbrauch“')
    expect(text).not.toContain('\n\n\n')
  })

  it('explains how to switch on what is missing', () => {
    const text = describeAppCapabilities({
      ...base,
      webAccess: false,
      image: { backend: 'openrouter', ready: false, model: 'x' },
      jev: { active: false, reason: 'Kein TypeSafe-API-Key gespeichert.' },
    })
    expect(text).toContain('NICHT aktiv: Kein TypeSafe-API-Key gespeichert.')
    expect(text).toContain('Einstellungen → „Jev (TypeSafe)“')
    expect(text).toContain('Behaupte nicht, Jev zu nutzen')
    expect(text).toContain('Einschalten: Einstellungen → Internet')
  })

  it('uses the prefixed tool names in coding mode and lists add-ons', () => {
    const text = describeAppCapabilities({
      ...base,
      mode: 'code',
      image: { backend: 'comfyui', url: 'http://127.0.0.1:8188' },
      workflows3d: ['Hunyuan3D'],
      skills: ['pdf', 'xlsx'],
      mcpServers: ['github'],
      plugins: 2,
    })
    expect(text).toContain('mcp__media__generate_image – aktiv, lokal über ComfyUI')
    expect(text).toContain('mcp__media__generate_3d_model über ComfyUI (Hunyuan3D)')
    expect(text).toContain('Skills (Werkzeug Skill): pdf, xlsx.')
    expect(text).toContain('Zusätzliche MCP-Server: github.')
    expect(text).toContain('2 Plugin(s) installiert.')
  })
})
