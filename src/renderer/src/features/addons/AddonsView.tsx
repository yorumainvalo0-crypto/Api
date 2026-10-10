import { useState } from 'react'
import { DiscoverTab } from './DiscoverTab'
import { InstalledTab } from './InstalledTab'
import { useOverview } from './useOverview'

type Tab = 'installed' | 'discover'

const TABS: { id: Tab; label: string }[] = [
  { id: 'installed', label: 'Installiert' },
  { id: 'discover', label: 'Entdecken' },
]

/** Manage skills, plugins and MCP servers. */
export function AddonsView() {
  const [tab, setTab] = useState<Tab>('installed')
  const data = useOverview()

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 p-8">
        <header>
          <h1 className="text-2xl font-semibold">Skills &amp; Add-ons</h1>
          <p className="text-sm text-zinc-500">
            Skills, Plugins und MCP-Server verwalten und neue entdecken.
          </p>
        </header>

        <div role="tablist" className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                tab === t.id
                  ? 'border-blue-600 font-medium text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Both tabs stay mounted so search results and drafts survive a tab switch. */}
        <div role="tabpanel" hidden={tab !== 'installed'}>
          <InstalledTab data={data} />
        </div>
        <div role="tabpanel" hidden={tab !== 'discover'}>
          <DiscoverTab onChanged={data.reload} />
        </div>
      </div>
    </div>
  )
}
