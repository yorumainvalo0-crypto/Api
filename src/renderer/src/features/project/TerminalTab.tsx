import { useRef, useState } from 'react'
import { TerminalPane, type TerminalPaneHandle } from '../terminal/TerminalPane'
import { SessionActions, Toolbar, type SessionState } from '../terminal/TerminalToolbar'

/** Interactive shell in the project folder, with a button that starts Claude Code in it. */
export function TerminalTab(props: { projectPath: string; active: boolean }) {
  const { projectPath, active } = props
  const pane = useRef<TerminalPaneHandle>(null)
  const [generation, setGeneration] = useState(0)
  const [state, setState] = useState<SessionState>('starting')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar>
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-500"
          title={projectPath}
        >
          {projectPath}
        </span>
        <SessionActions
          state={state}
          onStartClaude={() => pane.current?.run('claude')}
          onRestart={() => {
            setState('starting')
            setGeneration((n) => n + 1)
          }}
        />
      </Toolbar>
      <TerminalPane
        key={generation}
        ref={pane}
        cwd={projectPath}
        active={active}
        onStarted={() => setState('running')}
        onExit={() => setState('exited')}
      />
    </div>
  )
}
