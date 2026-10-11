import { useCallback, useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalCreated } from '@shared/schemas/terminal'
import { PERMISSION_MODE_LABELS } from '@shared/schemas/permissions'
import { api } from '../../lib/api'
import { cleanError } from '../../components/ModelPicker'

const DARK_THEME: ITheme = {
  background: '#18181b',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
  cursorAccent: '#18181b',
  selectionBackground: '#3f3f46',
}

const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#18181b',
  cursor: '#18181b',
  cursorAccent: '#ffffff',
  selectionBackground: '#bfdbfe',
  // The default palette is made for dark backgrounds; darken the light colours.
  black: '#18181b',
  red: '#b91c1c',
  green: '#15803d',
  yellow: '#a16207',
  blue: '#1d4ed8',
  magenta: '#a21caf',
  cyan: '#0e7490',
  white: '#71717a',
  brightBlack: '#52525b',
  brightRed: '#dc2626',
  brightGreen: '#16a34a',
  brightYellow: '#ca8a04',
  brightBlue: '#2563eb',
  brightMagenta: '#c026d3',
  brightCyan: '#0891b2',
  brightWhite: '#3f3f46',
}

const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

const isDark = () => document.documentElement.classList.contains('dark')

/** Lines that tell the user how `claude` will run in this session (mode, folder, sandbox). */
function claudeInfoLines(claude: TerminalCreated['claude']): string[] {
  const mode = `Freigabe „${PERMISSION_MODE_LABELS[claude.permissionMode]}“`
  const lines = [
    claude.workFolder
      ? `${DIM}Claude Code: ${mode} · nur im Arbeitsordner ${claude.workFolder}${RESET}`
      : `${YELLOW}Claude Code: ${mode} · NICHT auf einen Ordner beschränkt (Einstellungen)${RESET}`,
  ]
  if (claude.modeNote) lines.push(`${YELLOW}Hinweis: ${claude.modeNote}${RESET}`)
  if (claude.workFolder) {
    lines.push(
      claude.sandbox
        ? `${DIM}${claude.sandboxSummary}${RESET}`
        : `${YELLOW}Achtung: ${claude.sandboxSummary}${RESET}`,
    )
  }
  return lines
}

export interface TerminalPaneHandle {
  /** Types a command into the shell and runs it. */
  run(command: string): void
  focus(): void
}

/**
 * One interactive shell session (PTY in the main process) rendered with xterm.js. The session
 * starts on mount and is killed on unmount; remount (new `key`) to start a fresh one.
 */
export function TerminalPane(props: {
  /** Working directory; the home folder when undefined. */
  cwd?: string | undefined
  /** Visible right now (the container is display:none otherwise, so fit after showing). */
  active: boolean
  ref?: Ref<TerminalPaneHandle>
  onStarted?: (info: TerminalCreated) => void
  onExit?: (exitCode: number | null) => void
}) {
  const { cwd, active, ref, onStarted, onExit } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<string | null>(null)
  // Callbacks may change on every render; the session effect must not restart for that.
  const callbacks = useRef({ onStarted, onExit })
  useEffect(() => {
    callbacks.current = { onStarted, onExit }
  }, [onStarted, onExit])

  const fit = useCallback(() => {
    const container = containerRef.current
    if (!container || container.clientWidth === 0 || container.clientHeight === 0) return
    try {
      fitRef.current?.fit()
    } catch {
      // Not rendered yet.
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      run: (command) => {
        const sessionId = sessionRef.current
        if (!sessionId) return
        void api.invoke('terminal:write', { sessionId, data: `${command}\r` })
        termRef.current?.focus()
      },
      focus: () => termRef.current?.focus(),
    }),
    [],
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const sessionId = crypto.randomUUID()
    let alive = true
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Cascadia Mono', Consolas, ui-monospace, monospace",
      scrollback: 10_000,
      theme: isDark() ? DARK_THEME : LIGHT_THEME,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    termRef.current = term
    fitRef.current = fitAddon
    fit()

    // Copy with Ctrl+C when text is selected (else it interrupts), paste with Ctrl+V.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey) || e.altKey) return true
      const key = e.key.toLowerCase()
      if (key === 'c' && (e.shiftKey || term.hasSelection())) {
        const selection = term.getSelection()
        if (selection) void navigator.clipboard.writeText(selection)
        term.clearSelection()
        e.preventDefault()
        return false
      }
      // Let the browser fire its paste event, which xterm turns into input.
      if (key === 'v') return false
      return true
    })

    const offData = api.on('terminal:data', (e) => {
      if (e.sessionId === sessionId) term.write(e.data)
    })
    const offExit = api.on('terminal:exit', (e) => {
      if (e.sessionId !== sessionId) return
      sessionRef.current = null
      const code = e.exitCode
      term.writeln(`\r\n${DIM}[Sitzung beendet${code === null ? '' : ` mit Code ${code}`}]${RESET}`)
      callbacks.current.onExit?.(code)
    })
    const input = term.onData((data) => {
      if (sessionRef.current) void api.invoke('terminal:write', { sessionId, data })
    })
    const binary = term.onBinary((data) => {
      if (sessionRef.current) void api.invoke('terminal:write', { sessionId, data, binary: true })
    })
    const resize = term.onResize(({ cols, rows }) => {
      if (sessionRef.current) void api.invoke('terminal:resize', { sessionId, cols, rows })
    })

    api
      .invoke('terminal:create', {
        sessionId,
        ...(cwd ? { cwd } : {}),
        cols: Math.max(term.cols, 2),
        rows: Math.max(term.rows, 1),
      })
      .then(
        (info) => {
          if (!alive) {
            void api.invoke('terminal:kill', { sessionId })
            return
          }
          sessionRef.current = sessionId
          if (info.notice) term.writeln(`${YELLOW}Hinweis: ${info.notice}${RESET}`)
          for (const line of claudeInfoLines(info.claude)) term.writeln(line)
          // Size may have changed while the shell was starting.
          void api.invoke('terminal:resize', { sessionId, cols: term.cols, rows: term.rows })
          callbacks.current.onStarted?.(info)
        },
        (error: unknown) => {
          if (!alive) return
          term.writeln(`${RED}${cleanError(error)}${RESET}`)
          callbacks.current.onExit?.(null)
        },
      )

    // Follow the app theme (html.dark), also when it is toggled while the terminal is open.
    const themeObserver = new MutationObserver(() => {
      term.options.theme = isDark() ? DARK_THEME : LIGHT_THEME
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    const resizeObserver = new ResizeObserver(() => fit())
    resizeObserver.observe(container)

    return () => {
      alive = false
      themeObserver.disconnect()
      resizeObserver.disconnect()
      offData()
      offExit()
      input.dispose()
      binary.dispose()
      resize.dispose()
      if (sessionRef.current) void api.invoke('terminal:kill', { sessionId }).catch(() => undefined)
      sessionRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [cwd, fit])

  // The container is display:none while hidden; refit and focus when it becomes visible.
  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => {
      fit()
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [active, fit])

  // Same colours as the xterm themes, so the padding matches.
  return (
    <div className="min-h-0 flex-1 bg-white py-1 pl-2 dark:bg-zinc-900">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}
