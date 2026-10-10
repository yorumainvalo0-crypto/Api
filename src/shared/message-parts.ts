import type { AgentEvent } from './schemas/agent'
import type { MessagePart } from './schemas/chat'

/** Max characters of a tool result kept for display and storage. */
export const MAX_TOOL_RESULT_CHARS = 8000

/** Incrementally built assistant reply; shared by the main process (persistence) and the UI. */
export interface ReplyState {
  parts: MessagePart[]
  /** True once text arrived as stream deltas, so complete assistant texts are duplicates. */
  streamed: boolean
  error: string | null
  costUsd: number | null
  durationMs: number | null
}

export const EMPTY_REPLY: ReplyState = {
  parts: [],
  streamed: false,
  error: null,
  costUsd: null,
  durationMs: null,
}

function appendText(parts: MessagePart[], text: string, separator: string): MessagePart[] {
  const last = parts.at(-1)
  if (last?.type === 'text') {
    return [...parts.slice(0, -1), { type: 'text', text: last.text + separator + text }]
  }
  return [...parts, { type: 'text', text }]
}

/** Pure reducer: applies one agent event to the reply. */
export function applyReplyEvent(state: ReplyState, event: AgentEvent): ReplyState {
  switch (event.type) {
    case 'text-delta':
      return { ...state, streamed: true, parts: appendText(state.parts, event.text, '') }
    case 'assistant-text':
      return state.streamed
        ? state
        : { ...state, parts: appendText(state.parts, event.text, '\n\n') }
    case 'tool-use':
      return {
        ...state,
        parts: [
          ...state.parts,
          {
            type: 'tool',
            call: {
              id: event.toolUseId,
              name: event.name,
              input: event.input,
              result: null,
              isError: false,
            },
          },
        ],
      }
    case 'tool-result':
      return {
        ...state,
        parts: state.parts.map((p) =>
          p.type === 'tool' && p.call.id === event.toolUseId
            ? {
                ...p,
                call: {
                  ...p.call,
                  result: event.content.slice(0, MAX_TOOL_RESULT_CHARS),
                  isError: event.isError,
                },
              }
            : p,
        ),
      }
    case 'result':
      return {
        ...state,
        costUsd: event.costUsd,
        durationMs: event.durationMs,
        error: event.isError ? event.text || 'Unbekannter Fehler' : state.error,
      }
    case 'error':
      return { ...state, error: event.message }
    default:
      return state
  }
}

/** Plain text of a reply (used for titles, search and the legacy text column). */
export function partsToText(parts: MessagePart[]): string {
  return parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
}
