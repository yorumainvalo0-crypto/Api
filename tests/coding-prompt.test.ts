import { describe, expect, it } from 'vitest'
import {
  OPEN_CODING_PROMPT_SOURCE,
  OPEN_CODING_SYSTEM_PROMPT,
} from '../src/main/agent/prompts/open-coding-prompt'
import { isClaudeModel } from '../src/main/agent/prompts/select'

describe('coding system prompt selection', () => {
  it('keeps Claude Code for Claude models and uses the open prompt for others', () => {
    expect(isClaudeModel('anthropic', '')).toBe(true)
    expect(isClaudeModel('anthropic', 'claude-opus-5-5')).toBe(true)
    expect(isClaudeModel('openrouter', '')).toBe(true)
    expect(isClaudeModel('openrouter', 'anthropic/claude-sonnet-5.5')).toBe(true)
    expect(isClaudeModel('openrouter', 'openai/gpt-6')).toBe(false)
    expect(isClaudeModel('openrouter', 'qwen/qwen3-coder')).toBe(false)
    expect(isClaudeModel('ollama', 'qwen3:8b')).toBe(false)
  })

  it('ships the adapted Codex prompt with its license source', () => {
    expect(OPEN_CODING_PROMPT_SOURCE.license).toBe('Apache-2.0')
    expect(OPEN_CODING_SYSTEM_PROMPT).toContain('AI Workbench')
    expect(OPEN_CODING_SYSTEM_PROMPT).not.toMatch(/\bCodex\b/)
    expect(OPEN_CODING_SYSTEM_PROMPT.length).toBeGreaterThan(5000)
  })
})
