import { useState } from 'react'
import { FolderTree, GitBranch, SquareTerminal, type LucideIcon } from 'lucide-react'
import { FilesTab } from './FilesTab'
import { GitTab } from './GitTab'
import { TerminalTab } from './TerminalTab'

type TabId = 'files' | 'git' | 'terminal'

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'files', label: 'Dateien', icon: FolderTree },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
]

/**
 * Right-side panel for the coding mode: file tree + viewer, git status/diff/commit and a
 * command runner. All tabs stay mounted (so terminal output survives tab switches) and are
 * reset when `projectPath` changes.
 */
export function ProjectPanel(props: { projectPath: string }) {
  const { projectPath } = props
  const [tab, setTab] = useState<TabId>('files')

  return (
    <aside className="flex h-full w-[420px] shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div role="tablist" className="flex shrink-0 border-b border-zinc-200 dark:border-zinc-800">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
              tab === id
                ? 'border-blue-600 font-medium text-zinc-900 dark:text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>
      <div className={tab === 'files' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <FilesTab key={projectPath} projectPath={projectPath} />
      </div>
      <div className={tab === 'git' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <GitTab key={projectPath} projectPath={projectPath} active={tab === 'git'} />
      </div>
      <div className={tab === 'terminal' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <TerminalTab key={projectPath} projectPath={projectPath} active={tab === 'terminal'} />
      </div>
    </aside>
  )
}
