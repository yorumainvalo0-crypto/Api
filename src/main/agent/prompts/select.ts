import type { ProviderId } from '@shared/schemas/settings'

/**
 * Whether the coding agent runs a Claude model, which keeps the built-in Claude Code system
 * prompt. Anthropic is always Claude; on OpenRouter an empty model means the runtime's Claude
 * default; local Ollama models are never Claude.
 */
export function isClaudeModel(provider: ProviderId, model: string): boolean {
  if (provider === 'anthropic') return true
  if (provider === 'ollama') return false
  const id = model.trim().toLowerCase()
  return id === '' || id.startsWith('anthropic/') || id.includes('claude')
}
