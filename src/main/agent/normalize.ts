import type { AgentEvent } from '@shared/schemas/agent'

/**
 * Minimal structural view of the SDK messages we consume. Kept local so the mapping
 * stays unit-testable without spawning the runtime.
 */
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: string }

type UserContentBlock =
  | {
      type: 'tool_result'
      tool_use_id: string
      content?: string | { type: string; text?: string }[]
      is_error?: boolean
    }
  | { type: string }

/** Flattens tool result content (string or blocks) into display text. */
export function toolResultText(
  content: string | { type: string; text?: string }[] | undefined,
): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content.map((b) => (b.type === 'text' ? (b.text ?? '') : `[${b.type}]`)).join('\n')
}

export type SdkMessageLike =
  | { type: 'system'; subtype: 'init'; model: string; tools: string[]; session_id: string }
  | { type: 'system'; subtype: string; session_id?: string }
  | { type: 'assistant'; message: { content: ContentBlock[] }; parent_tool_use_id: string | null }
  | {
      type: 'user'
      message: { content: string | UserContentBlock[] }
      parent_tool_use_id: string | null
    }
  | {
      type: 'stream_event'
      event: { type: string; delta?: { type: string; text?: string } }
      parent_tool_use_id: string | null
    }
  | {
      type: 'result'
      subtype: string
      is_error: boolean
      total_cost_usd: number
      duration_ms: number
      result?: string
      errors?: string[]
    }
  | { type: string }

/** Converts one SDK message into zero or more renderer events. */
export function normalizeSdkMessage(chatId: string, msg: SdkMessageLike): AgentEvent[] {
  switch (msg.type) {
    case 'system': {
      if ('subtype' in msg && msg.subtype === 'init' && 'model' in msg && 'tools' in msg) {
        return [{ chatId, type: 'init', model: msg.model, tools: msg.tools }]
      }
      return []
    }
    case 'stream_event': {
      if (!('event' in msg) || msg.parent_tool_use_id !== null) return []
      const { event } = msg
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        return event.delta.text ? [{ chatId, type: 'text-delta', text: event.delta.text }] : []
      }
      return []
    }
    case 'assistant': {
      if (!('message' in msg) || msg.parent_tool_use_id !== null) return []
      const events: AgentEvent[] = []
      for (const block of msg.message.content) {
        if (block.type === 'text' && 'text' in block) {
          events.push({ chatId, type: 'assistant-text', text: block.text })
        } else if (block.type === 'tool_use' && 'id' in block) {
          events.push({
            chatId,
            type: 'tool-use',
            toolUseId: block.id,
            name: block.name,
            input: block.input,
          })
        }
      }
      return events
    }
    case 'user': {
      if (!('message' in msg) || msg.parent_tool_use_id !== null) return []
      const { content } = msg.message
      if (typeof content === 'string') return []
      const events: AgentEvent[] = []
      for (const block of content) {
        if (block.type === 'tool_result' && 'tool_use_id' in block) {
          events.push({
            chatId,
            type: 'tool-result',
            toolUseId: block.tool_use_id,
            content: toolResultText(block.content),
            isError: block.is_error === true,
          })
        }
      }
      return events
    }
    case 'result': {
      if (!('is_error' in msg)) return []
      const text =
        msg.subtype === 'error_max_budget_usd'
          ? 'Kostenlimit für diese Anfrage erreicht (Einstellungen → Kostenlimit).'
          : (msg.result ?? msg.errors?.join('\n') ?? '')
      return [
        {
          chatId,
          type: 'result',
          isError: msg.is_error || msg.subtype !== 'success',
          text,
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
        },
      ]
    }
    default:
      return []
  }
}
