import { useCallback, useRef, useState } from 'react'
import { FolderOpen, Plus, SquareTerminal, X } from 'lucide-react'
import { api } from '../../lib/api'
import { TerminalPane, type TerminalPaneHandle } from './TerminalPane'
import { folderName, SessionActions, Toolbar, type SessionState } from './TerminalToolbar'

interface Tab {
  /** React key; a restart gives the tab a new one so a fresh session starts. */
  key: string
  /** Working directory; undefined = home folder. */
  cwd: string | undefined
  title: string
  state: SessionState
}

const newTab = (cwd?: string): Tab => ({
  key: crypto.randomUUID(),
  cwd,
  title: cwd ? folderName(cwd) : 'Home',
  state: 'starting',
})

/**
 * Standalone terminal view: several shells in tabs, starting in the home folder or a picked
 * folder, each with a button that starts Claude Code. Stays mounted while other views are shown.
 */
export function TerminalView(props: { active: boolean }) {
  const { active } = props
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab()])
  const [activeKey, setActiveKey] = useState<string | undefined>(() => tabs[0]?.key)
  const handles = useRef(new Map<string, TerminalPaneHandle>())
  const current = tabs.find((t) => t.key === activeKey)

  const update = useCallback((key: string, patch: Partial<Tab>) => {
    setTabs((list) => list.map((t) => (t.key === key ? { ...t, ...patch } : t)))
  }, [])

  const open = (cwd?: string) => {
    const tab = newTab(cwd)
    setTabs((list) => [...list, tab])
    setActiveKey(tab.key)
  }

  const pickFolder = async () => {
    const folder = await api.invoke('dialog:open-folder')
    if (folder) open(folder)
  }

  const close = (key: string) => {
    const index = tabs.findIndex((t) => t.key === key)
    const next = tabs.filter((t) => t.key !== key)
    setTabs(next)
    if (key === activeKey) setActiveKey((next[index] ?? next[index - 1])?.key)
  }

  const restart = (tab: Tab) => {
    const fresh = { ...newTab(tab.cwd), title: tab.title }
    setTabs((list) => list.map((t) => (t.key === tab.key ? fresh : t)))
    setActiveKey(fresh.key)
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Toolbar>
        <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.key}
              className={`group flex shrink-0 items-center rounded-md text-sm ${
                tab.key === activeKey
                  ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                  : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800/60'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab.key === activeKey}
                title={tab.cwd ?? 'Home-Ordner'}
                onClick={() => setActiveKey(tab.key)}
                className="flex max-w-48 items-center gap-1.5 py-1 pl-2"
              >
                <SquareTerminal size={13} className="shrink-0" />
                <span className={`truncate ${tab.state === 'exited' ? 'line-through' : ''}`}>
                  {tab.title}
                </span>
              </button>
              <button
                type="button"
                title="Terminal schließen"
                aria-label="Terminal schließen"
                onClick={() => close(tab.key)}
                className="mx-1 rounded p-0.5 opacity-60 hover:bg-zinc-300 hover:opacity-100 dark:hover:bg-zinc-700"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button
            type="button"
            title="Neues Terminal im Home-Ordner"
            aria-label="Neues Terminal im Home-Ordner"
            onClick={() => open()}
            className="shrink-0 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            title="Terminal in einem Ordner öffnen"
            onClick={() => void pickFolder()}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <FolderOpen size={13} />
            Ordner wählen …
          </button>
        </div>
        {current ? (
          <SessionActions
            state={current.state}
            onStartClaude={() => handles.current.get(current.key)?.run('claude')}
            onRestart={() => restart(current)}
          />
        ) : null}
      </Toolbar>
      {tabs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-zinc-500">
          Kein Terminal geöffnet.
          <button
            type="button"
            onClick={() => open()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700"
          >
            Neues Terminal
          </button>
        </div>
      ) : null}
      {tabs.map((tab) => (
        <div
          key={tab.key}
          className={tab.key === activeKey ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
        >
          <TerminalPane
            ref={(handle) => {
              if (handle) handles.current.set(tab.key, handle)
              else handles.current.delete(tab.key)
            }}
            cwd={tab.cwd}
            active={active && tab.key === activeKey}
            onStarted={() => update(tab.key, { state: 'running' })}
            onExit={() => update(tab.key, { state: 'exited' })}
          />
        </div>
      ))}
    </div>
  )
}
