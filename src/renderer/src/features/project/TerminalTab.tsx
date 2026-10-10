import { useCallback, useEffect, useRef, useState } from 'react'
import { Eraser, Play, Square } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalOutput } from '@shared/schemas/project'
import { api } from '../../lib/api'
import { cleanError } from '../../components/ModelPicker'

const HISTORY_LIMIT = 100
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const PROMPT = '\x1b[1;36m'
const RESET = '\x1b[0m'

interface RunState {
  runId: string | null
  /** True while terminal:run is pending; events for unknown runs are buffered meanwhile. */
  starting: boolean
  early: TerminalOutput[]
  history: string[]
  /** Position while browsing the history with ↑/↓ (history.length = new input). */
  historyIndex: number
}

/** Non-interactive command runner: one command at a time, output rendered with xterm.js. */
export function TerminalTab(props: { projectPath: string; active: boolean }) {
  const { projectPath, active } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const state = useRef<RunState>({
    runId: null,
    starting: false,
    early: [],
    history: [],
    historyIndex: 0,
  })
  const [command, setCommand] = useState('')
  const [running, setRunning] = useState(false)

  const fit = useCallback(() => {
    const container = containerRef.current
    if (!container || container.clientWidth === 0 || container.clientHeight === 0) return
    try {
      fitRef.current?.fit()
    } catch {
      // Not rendered yet.
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const term = new Terminal({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: 'bar',
      fontSize: 12,
      fontFamily: "'Cascadia Mono', Consolas, ui-monospace, monospace",
      scrollback: 5000,
      theme: { background: '#18181b', foreground: '#e4e4e7' },
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    termRef.current = term
    fitRef.current = fitAddon
    term.writeln(`${DIM}Befehle laufen in ${projectPath} (nicht interaktiv).${RESET}`)

    const observer = new ResizeObserver(() => fit())
    observer.observe(container)
    fit()
    return () => {
      observer.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [projectPath, fit])

  // The container is display:none while another tab is shown; refit when it becomes visible.
  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => fit())
    return () => cancelAnimationFrame(frame)
  }, [active, fit])

  const handleEvent = useCallback((event: TerminalOutput) => {
    const term = termRef.current
    const s = state.current
    switch (event.kind) {
      case 'stdout':
      case 'stderr':
        term?.write(event.data)
        break
      case 'error':
        term?.writeln(`${RED}${event.data}${RESET}`)
        break
      case 'exit': {
        const code = event.exitCode
        const text =
          code === null || code === undefined ? 'Abgebrochen' : `Beendet mit Code ${code}`
        term?.writeln(`${code === 0 ? DIM : RED}[${text}]${RESET}`)
        s.runId = null
        setRunning(false)
        break
      }
    }
  }, [])

  useEffect(() => {
    const s = state.current
    const off = api.on('terminal:output', (event) => {
      if (event.runId === s.runId) handleEvent(event)
      else if (s.starting) s.early.push(event)
    })
    return () => {
      off()
      // Leaving the project (or closing the panel) stops a running command.
      if (s.runId) void api.invoke('terminal:kill', { runId: s.runId }).catch(() => undefined)
    }
  }, [handleEvent])

  const run = async () => {
    const cmd = command.trim()
    const s = state.current
    if (!cmd || running) return
    if (s.history[s.history.length - 1] !== cmd) s.history.push(cmd)
    if (s.history.length > HISTORY_LIMIT) s.history.shift()
    s.historyIndex = s.history.length
    setCommand('')
    termRef.current?.writeln(`${PROMPT}> ${cmd}${RESET}`)
    setRunning(true)
    s.starting = true
    s.early = []
    try {
      const { runId } = await api.invoke('terminal:run', { projectPath, command: cmd })
      s.runId = runId
      const early = s.early.filter((e) => e.runId === runId)
      s.early = []
      s.starting = false
      for (const event of early) handleEvent(event)
    } catch (e) {
      s.starting = false
      s.early = []
      termRef.current?.writeln(`${RED}${cleanError(e)}${RESET}`)
      setRunning(false)
    }
  }

  const stop = () => {
    const runId = state.current.runId
    if (runId) void api.invoke('terminal:kill', { runId })
  }

  const browseHistory = (direction: -1 | 1) => {
    const s = state.current
    const next = Math.min(Math.max(s.historyIndex + direction, 0), s.history.length)
    if (next === s.historyIndex && direction === -1 && s.history.length === 0) return
    s.historyIndex = next
    setCommand(s.history[next] ?? '')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 bg-zinc-900 py-1 pl-2">
        <div ref={containerRef} className="h-full w-full" />
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-t border-zinc-200 p-2 dark:border-zinc-800">
        <span className="font-mono text-sm text-zinc-400">&gt;</span>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void run()
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              browseHistory(-1)
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              browseHistory(1)
            } else if (
              e.key === 'c' &&
              e.ctrlKey &&
              running &&
              !window.getSelection()?.toString()
            ) {
              e.preventDefault()
              stop()
            }
          }}
          disabled={running}
          spellCheck={false}
          placeholder={running ? 'Befehl läuft …' : 'Befehl eingeben, Enter zum Ausführen'}
          className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-transparent px-2 py-1 font-mono text-sm disabled:opacity-60 dark:border-zinc-700"
        />
        {running ? (
          <button
            type="button"
            title="Stoppen (Strg+C)"
            onClick={stop}
            className="flex items-center gap-1 rounded-md bg-red-600 px-2 py-1 text-sm text-white hover:bg-red-700"
          >
            <Square size={14} />
            Stopp
          </button>
        ) : (
          <button
            type="button"
            title="Ausführen"
            onClick={() => void run()}
            disabled={!command.trim()}
            className="rounded-md bg-blue-600 p-1.5 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Play size={14} />
          </button>
        )}
        <button
          type="button"
          title="Ausgabe leeren"
          onClick={() => termRef.current?.clear()}
          className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <Eraser size={14} />
        </button>
      </div>
    </div>
  )
}
