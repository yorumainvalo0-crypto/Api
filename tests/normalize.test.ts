import { describe, expect, it } from 'vitest'
import { normalizeSdkMessage } from '../src/main/agent/normalize'
import { toUnpackedPath, resolveClaudeExecutable } from '../src/main/agent/executable'

describe('normalizeSdkMessage', () => {
  it('maps init, deltas, assistant blocks and results', () => {
    expect(
      normalizeSdkMessage('s', {
        type: 'system',
        subtype: 'init',
        model: 'm',
        tools: ['Read'],
        session_id: 'x',
      }),
    ).toEqual([{ chatId: 's', type: 'init', model: 'm', tools: ['Read'] }])

    expect(
      normalizeSdkMessage('s', {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
      }),
    ).toEqual([{ chatId: 's', type: 'text-delta', text: 'Hi' }])

    expect(
      normalizeSdkMessage('s', {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } },
          ],
        },
      }),
    ).toEqual([
      { chatId: 's', type: 'assistant-text', text: 'Hello' },
      { chatId: 's', type: 'tool-use', toolUseId: 't1', name: 'Read', input: { path: 'a' } },
    ])

    expect(
      normalizeSdkMessage('s', {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        total_cost_usd: 0,
        duration_ms: 5,
        errors: ['boom'],
      }),
    ).toEqual([
      { chatId: 's', type: 'result', isError: true, text: 'boom', costUsd: 0, durationMs: 5 },
    ])
  })

  it('ignores subagent output and unknown messages', () => {
    expect(
      normalizeSdkMessage('s', {
        type: 'stream_event',
        parent_tool_use_id: 'parent',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } },
      }),
    ).toEqual([])
    expect(normalizeSdkMessage('s', { type: 'rate_limit_event' })).toEqual([])
  })
})

describe('executable resolution', () => {
  it('rewrites asar paths to the unpacked directory', () => {
    expect(toUnpackedPath('C:\\App\\resources\\app.asar\\node_modules\\x\\claude.exe')).toBe(
      'C:\\App\\resources\\app.asar.unpacked\\node_modules\\x\\claude.exe',
    )
    expect(toUnpackedPath('/opt/app/resources/app.asar/node_modules/x/claude')).toBe(
      '/opt/app/resources/app.asar.unpacked/node_modules/x/claude',
    )
  })

  it('picks claude.exe on Windows', () => {
    const seen: string[] = []
    resolveClaudeExecutable('win32', 'x64', (id) => {
      seen.push(id)
      return id
    })
    expect(seen).toEqual(['@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'])
  })

  it('finds the installed runtime for this platform', () => {
    expect(resolveClaudeExecutable()).toMatch(/claude(\.exe)?$/)
  })
})
