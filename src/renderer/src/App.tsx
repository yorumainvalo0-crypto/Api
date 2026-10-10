import { useCallback, useEffect, useState } from 'react'
import { BarChart3, MessageSquare, Moon, Puzzle, Settings as SettingsIcon, Sun } from 'lucide-react'
import type { Settings } from '@shared/schemas/settings'
import type { ChatSummary } from '@shared/schemas/chat'
import { api } from './lib/api'
import { ChatView } from './features/chat/ChatView'
import { ChatSidebar } from './features/chat/ChatSidebar'
import { SettingsView } from './features/settings/SettingsView'
import { AddonsView } from './features/addons/AddonsView'
import { UsageView } from './features/usage/UsageView'

type View = 'chat' | 'addons' | 'usage' | 'settings'

export function App() {
  const [view, setView] = useState<View>('chat')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [activeChatId, setActiveChatId] = useState<string>(() => crypto.randomUUID())
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set())

  const refreshChats = useCallback(() => {
    void api.invoke('chats:list').then(setChats)
  }, [])

  useEffect(() => {
    void api.invoke('settings:get').then(setSettings)
    refreshChats()
  }, [refreshChats])

  // Track which chats have a run in progress, independent of the visible chat,
  // and refresh the chat list when a chat is created (init) or finished (done).
  useEffect(() => {
    return api.on('agent:event', (event) => {
      if (event.type === 'init' || event.type === 'done') refreshChats()
      setRunning((prev) => {
        const busy = event.type !== 'done'
        if (prev.has(event.chatId) === busy) return prev
        const next = new Set(prev)
        if (busy) next.add(event.chatId)
        else next.delete(event.chatId)
        return next
      })
    })
  }, [refreshChats])

  const dark = useTheme(settings?.theme ?? 'dark')
  const toggleTheme = useCallback(async () => {
    setSettings(await api.invoke('settings:update', { theme: dark ? 'light' : 'dark' }))
  }, [dark])
  const [focusSearch, setFocusSearch] = useState(0)

  const openProject = useCallback(async () => {
    const projectPath = await api.invoke('dialog:open-folder')
    if (!projectPath) return
    const chat = await api.invoke('chats:create-project', { projectPath })
    refreshChats()
    setView('chat')
    setActiveChatId(chat.id)
  }, [refreshChats])

  // Keyboard shortcuts: Ctrl+N new chat, Ctrl+Shift+O open project, Ctrl+K search, Ctrl+, settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const key = e.key.toLowerCase()
      if (key === 'n' && !e.shiftKey) {
        e.preventDefault()
        setView('chat')
        setActiveChatId(crypto.randomUUID())
      } else if (key === 'o' && e.shiftKey) {
        e.preventDefault()
        void openProject()
      } else if (key === 'k') {
        e.preventDefault()
        setView('chat')
        setFocusSearch((n) => n + 1)
      } else if (key === ',') {
        e.preventDefault()
        setView('settings')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openProject])

  return (
    <div className="flex h-full">
      <nav className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-zinc-200 bg-zinc-50 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <NavButton label="Chat" active={view === 'chat'} onClick={() => setView('chat')}>
          <MessageSquare size={20} />
        </NavButton>
        <NavButton
          label="Skills & Add-ons"
          active={view === 'addons'}
          onClick={() => setView('addons')}
        >
          <Puzzle size={20} />
        </NavButton>
        <NavButton label="Verbrauch" active={view === 'usage'} onClick={() => setView('usage')}>
          <BarChart3 size={20} />
        </NavButton>
        <NavButton
          label="Einstellungen"
          active={view === 'settings'}
          onClick={() => setView('settings')}
        >
          <SettingsIcon size={20} />
        </NavButton>
        <div className="mt-auto" />
        <NavButton
          label={dark ? 'Hell darstellen' : 'Dunkel darstellen'}
          active={false}
          onClick={() => void toggleTheme()}
        >
          {dark ? <Sun size={20} /> : <Moon size={20} />}
        </NavButton>
      </nav>
      <main className="flex min-w-0 flex-1">
        {settings === null ? null : view === 'chat' ? (
          <>
            <ChatSidebar
              chats={chats}
              activeId={activeChatId}
              onSelect={setActiveChatId}
              onNew={() => setActiveChatId(crypto.randomUUID())}
              onOpenProject={() => void openProject()}
              focusSearch={focusSearch}
              onChanged={refreshChats}
            />
            <ChatView
              key={activeChatId}
              chatId={activeChatId}
              settings={settings}
              running={running.has(activeChatId)}
              onSettingsChange={setSettings}
            />
          </>
        ) : view === 'addons' ? (
          <AddonsView />
        ) : view === 'usage' ? (
          <UsageView />
        ) : (
          <SettingsView settings={settings} onChange={setSettings} />
        )}
      </main>
    </div>
  )
}

function NavButton(props: {
  label: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      onClick={props.onClick}
      className={`rounded-lg p-2 transition-colors ${
        props.active
          ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
          : 'text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60'
      }`}
    >
      {props.children}
    </button>
  )
}

/** Applies the theme to <html> and returns whether dark mode is active. */
function useTheme(theme: Settings['theme']): boolean {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  const dark = theme === 'dark' || (theme === 'system' && systemDark)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])
  return dark
}
