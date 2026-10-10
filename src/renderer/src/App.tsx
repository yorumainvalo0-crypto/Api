import { useEffect, useState } from 'react'
import { MessageSquare, Settings as SettingsIcon } from 'lucide-react'
import type { Settings } from '@shared/schemas/settings'
import { api } from './lib/api'
import { ChatView } from './features/chat/ChatView'
import { SettingsView } from './features/settings/SettingsView'

type View = 'chat' | 'settings'

export function App() {
  const [view, setView] = useState<View>('chat')
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    void api.invoke('settings:get').then(setSettings)
  }, [])

  useTheme(settings?.theme ?? 'system')

  return (
    <div className="flex h-full">
      <nav className="flex w-14 flex-col items-center gap-2 border-r border-zinc-200 bg-zinc-50 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <NavButton label="Chat" active={view === 'chat'} onClick={() => setView('chat')}>
          <MessageSquare size={20} />
        </NavButton>
        <NavButton
          label="Einstellungen"
          active={view === 'settings'}
          onClick={() => setView('settings')}
        >
          <SettingsIcon size={20} />
        </NavButton>
      </nav>
      <main className="min-w-0 flex-1">
        {settings === null ? null : view === 'chat' ? (
          <ChatView settings={settings} />
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

function useTheme(theme: Settings['theme']) {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}
