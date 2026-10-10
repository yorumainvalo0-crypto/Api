import type { ReactNode } from 'react'
import { RotateCcw, Sparkles } from 'lucide-react'

export type SessionState = 'starting' | 'running' | 'exited'

const BUTTON =
  'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50'

/** "Claude Code starten" plus "Neu starten" once the shell has ended. */
export function SessionActions(props: {
  state: SessionState
  onStartClaude: () => void
  onRestart: () => void
}) {
  const { state, onStartClaude, onRestart } = props
  return (
    <>
      {state === 'exited' ? (
        <button
          type="button"
          onClick={onRestart}
          title="Neue Sitzung im selben Ordner starten"
          className={`${BUTTON} text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800`}
        >
          <RotateCcw size={13} />
          Neu starten
        </button>
      ) : null}
      <button
        type="button"
        onClick={onStartClaude}
        disabled={state !== 'running'}
        title="Startet Claude Code (claude) in diesem Terminal – mit den Zugangsdaten und dem Modell der App"
        className={`${BUTTON} bg-blue-600 text-white hover:bg-blue-700`}
      >
        <Sparkles size={13} />
        Claude Code starten
      </button>
    </>
  )
}

export function Toolbar(props: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
      {props.children}
    </div>
  )
}

/** Last path segment for tab titles (Windows or POSIX separators). */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
