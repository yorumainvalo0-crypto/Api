import { useState } from 'react'
import {
  CheckCircle2,
  ChevronRight,
  FilePen,
  FilePlus,
  FileSearch,
  Globe,
  ListTodo,
  Loader2,
  Search,
  TerminalSquare,
  Wrench,
  XCircle,
} from 'lucide-react'
import type { ToolCall } from '@shared/schemas/chat'
import { diffLines } from '@shared/line-diff'

type Input = Record<string, unknown>

function str(input: Input, key: string): string {
  const value = input[key]
  return typeof value === 'string' ? value : ''
}

/** Short human-readable description of a tool call. */
export function describeTool(call: ToolCall): { icon: React.ReactNode; title: string } {
  const input = (call.input ?? {}) as Input
  const file = str(input, 'file_path') || str(input, 'path') || str(input, 'notebook_path')
  switch (call.name) {
    case 'Read':
      return { icon: <FileSearch size={14} />, title: `Liest ${file}` }
    case 'Write':
      return { icon: <FilePlus size={14} />, title: `Schreibt ${file}` }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { icon: <FilePen size={14} />, title: `Bearbeitet ${file}` }
    case 'Bash':
    case 'PowerShell':
      return {
        icon: <TerminalSquare size={14} />,
        title: str(input, 'description') || str(input, 'command'),
      }
    case 'Grep':
    case 'Glob':
      return { icon: <Search size={14} />, title: `Sucht „${str(input, 'pattern')}“` }
    case 'WebFetch':
    case 'WebSearch':
      return { icon: <Globe size={14} />, title: str(input, 'url') || str(input, 'query') }
    case 'TodoWrite':
      return { icon: <ListTodo size={14} />, title: 'Aufgabenliste aktualisiert' }
    default:
      return { icon: <Wrench size={14} />, title: call.name.replace(/^mcp__/, '') }
  }
}

export function ToolCard({ call, running }: { call: ToolCall; running: boolean }) {
  const [open, setOpen] = useState(call.isError)
  const { icon, title } = describeTool(call)
  const pending = call.result === null

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 text-sm dark:border-zinc-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 bg-zinc-50 px-3 py-1.5 text-left hover:bg-zinc-100 dark:bg-zinc-900 dark:hover:bg-zinc-800"
      >
        <ChevronRight
          size={14}
          className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="shrink-0 text-zinc-500">{icon}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{title}</span>
        {pending ? (
          running ? (
            <Loader2 size={14} className="shrink-0 animate-spin text-zinc-400" />
          ) : null
        ) : call.isError ? (
          <XCircle size={14} className="shrink-0 text-red-500" />
        ) : (
          <CheckCircle2 size={14} className="shrink-0 text-green-600" />
        )}
      </button>
      {open && <ToolDetails call={call} />}
    </div>
  )
}

function ToolDetails({ call }: { call: ToolCall }) {
  const input = (call.input ?? {}) as Input
  let body: React.ReactNode

  if (call.name === 'Edit') {
    body = <DiffView before={str(input, 'old_string')} after={str(input, 'new_string')} />
  } else if (call.name === 'MultiEdit' && Array.isArray(input['edits'])) {
    body = (input['edits'] as Input[]).map((edit, i) => (
      <DiffView key={i} before={str(edit, 'old_string')} after={str(edit, 'new_string')} />
    ))
  } else if (call.name === 'Write') {
    body = <DiffView before="" after={str(input, 'content')} />
  } else if (call.name === 'Bash' || call.name === 'PowerShell') {
    body = <pre className="tool-pre">$ {str(input, 'command')}</pre>
  } else if (call.name !== 'Read') {
    body = <pre className="tool-pre">{JSON.stringify(call.input, null, 2)}</pre>
  }

  return (
    <div className="space-y-2 border-t border-zinc-200 p-2 dark:border-zinc-800">
      {body}
      {call.result !== null && call.result !== '' && (
        <pre className={`tool-pre max-h-72 ${call.isError ? 'text-red-400' : ''}`}>
          {call.result}
        </pre>
      )}
    </div>
  )
}

function DiffView({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after)
  return (
    <pre className="tool-pre max-h-96">
      {lines.map((line, i) => (
        <div
          key={i}
          className={
            line.kind === 'add'
              ? 'bg-green-500/15 text-green-300'
              : line.kind === 'remove'
                ? 'bg-red-500/15 text-red-300'
                : 'text-zinc-400'
          }
        >
          {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}
          {line.text}
        </div>
      ))}
    </pre>
  )
}
