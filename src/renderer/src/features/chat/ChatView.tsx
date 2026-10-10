import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Plus, Send, Square } from 'lucide-react'
import { PROVIDER_LABELS, type Settings } from '@shared/schemas/settings'
import type { AgentEvent } from '@shared/schemas/agent'
import { api } from '../../lib/api'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  tools: string[]
  error?: string
  meta?: string
}

export function ChatView({ settings }: { settings: Settings }) {
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID())
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const streamedRef = useRef(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return api.on('agent:event', (event) => {
      if (event.sessionId !== sessionId) return
      setMessages((prev) => applyEvent(prev, event, streamedRef))
      if (event.type === 'done') setBusy(false)
    })
  }, [sessionId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = async () => {
    const prompt = draft.trim()
    if (!prompt || busy) return
    setDraft('')
    setBusy(true)
    streamedRef.current = false
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', text: prompt, tools: [] },
      { id: crypto.randomUUID(), role: 'assistant', text: '', tools: [] },
    ])
    const { accepted } = await api.invoke('agent:send', { sessionId, prompt })
    if (!accepted) setBusy(false)
  }

  const newChat = () => {
    if (busy) void api.invoke('agent:cancel', { sessionId })
    setSessionId(crypto.randomUUID())
    setMessages([])
    setBusy(false)
  }

  const model = settings.models[settings.activeProvider] || 'Standardmodell'

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <div className="text-sm text-zinc-500">
          {PROVIDER_LABELS[settings.activeProvider]} · {model}
        </div>
        <button
          type="button"
          onClick={newChat}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <Plus size={16} /> Neuer Chat
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-6">
          {messages.length === 0 && (
            <p className="pt-24 text-center text-zinc-400">Womit kann ich helfen?</p>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={draft}
            rows={Math.min(8, Math.max(1, draft.split('\n').length))}
            placeholder="Nachricht schreiben … (Enter senden, Shift+Enter Zeilenumbruch)"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            className="min-h-10 flex-1 resize-none rounded-lg border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
          />
          {busy ? (
            <IconButton
              label="Stoppen"
              onClick={() => void api.invoke('agent:cancel', { sessionId })}
            >
              <Square size={18} />
            </IconButton>
          ) : (
            <IconButton label="Senden" onClick={() => void send()} disabled={!draft.trim()}>
              <Send size={18} />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  )
}

function applyEvent(
  prev: ChatMessage[],
  event: AgentEvent,
  streamedRef: { current: boolean },
): ChatMessage[] {
  const last = prev.at(-1)
  if (!last || last.role !== 'assistant') return prev
  const patch = (update: Partial<ChatMessage>) => [...prev.slice(0, -1), { ...last, ...update }]

  switch (event.type) {
    case 'text-delta':
      streamedRef.current = true
      return patch({ text: last.text + event.text })
    case 'assistant-text':
      // Only used when the provider did not stream deltas.
      return streamedRef.current ? prev : patch({ text: joinText(last.text, event.text) })
    case 'tool-use':
      return patch({ tools: [...last.tools, event.name] })
    case 'result':
      return patch({
        ...(event.isError ? { error: event.text || 'Unbekannter Fehler' } : {}),
        meta: `${(event.durationMs / 1000).toFixed(1)} s · $${event.costUsd.toFixed(4)}`,
      })
    case 'error':
      return patch({ error: event.message })
    default:
      return prev
  }
}

function joinText(a: string, b: string): string {
  return a ? `${a}\n\n${b}` : b
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-blue-600 px-4 py-2 whitespace-pre-wrap text-white">
          {message.text}
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-1">
      {message.tools.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {message.tools.map((t, i) => (
            <span
              key={i}
              className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800"
            >
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="prose-chat">
        {message.text ? (
          <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
        ) : (
          !message.error && <span className="animate-pulse text-zinc-400">…</span>
        )}
      </div>
      {message.error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {message.error}
        </div>
      )}
      {message.meta && <div className="text-xs text-zinc-400">{message.meta}</div>}
    </div>
  )
}

function IconButton(props: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-600 text-white disabled:opacity-40"
    >
      {props.children}
    </button>
  )
}
