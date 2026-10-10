import { useCallback, useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, GitBranch, GitCommitHorizontal, RefreshCw, X } from 'lucide-react'
import type { GitCommitResult, GitFile, GitFileStatus, GitStatus } from '@shared/schemas/project'
import { api } from '../../lib/api'
import { cleanError } from '../../components/ModelPicker'
import { DiffView } from './DiffView'

const STATUS_BADGE: Record<GitFileStatus, { letter: string; label: string; className: string }> = {
  modified: { letter: 'M', label: 'Geändert', className: 'text-amber-600 dark:text-amber-400' },
  added: { letter: 'A', label: 'Hinzugefügt', className: 'text-green-600 dark:text-green-400' },
  deleted: { letter: 'D', label: 'Gelöscht', className: 'text-red-600 dark:text-red-400' },
  renamed: { letter: 'R', label: 'Umbenannt', className: 'text-blue-600 dark:text-blue-400' },
  untracked: { letter: 'U', label: 'Neu (nicht versioniert)', className: 'text-green-600' },
  conflicted: { letter: '!', label: 'Konflikt', className: 'text-red-600 dark:text-red-400' },
}

interface Selection {
  path: string
  staged: boolean
}

/** Branch info, changed files with diffs and a commit box. Loads whenever the tab is shown. */
export function GitTab(props: { projectPath: string; active: boolean }) {
  const { projectPath, active } = props
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [selected, setSelected] = useState<Selection | null>(null)
  const [diff, setDiff] = useState<{ text: string | null; error: string | null } | null>(null)
  const [message, setMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [commitResult, setCommitResult] = useState<GitCommitResult | null>(null)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    api.invoke('git:status', { projectPath }).then(
      (s) => {
        if (cancelled) return
        setStatus(s)
        setError(null)
        setLoading(false)
      },
      (e: unknown) => {
        if (cancelled) return
        setError(cleanError(e))
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [projectPath, active, reloadToken])

  const loadDiff = useCallback(
    async (sel: Selection) => {
      setDiff({ text: null, error: null })
      try {
        const text = await api.invoke('git:diff', { projectPath, ...sel })
        setDiff({ text, error: null })
      } catch (e) {
        setDiff({ text: null, error: cleanError(e) })
      }
    },
    [projectPath],
  )

  const reload = () => {
    setLoading(true)
    setReloadToken((t) => t + 1)
    if (selected) void loadDiff(selected)
  }

  const select = (file: GitFile) => {
    const sel = { path: file.path, staged: file.staged }
    setSelected(sel)
    void loadDiff(sel)
  }

  const commit = async () => {
    if (!message.trim() || committing) return
    setCommitting(true)
    setCommitResult(null)
    try {
      const result = await api.invoke('git:commit', { projectPath, message, stageAll: true })
      setCommitResult(result)
      if (result.ok) {
        setMessage('')
        setSelected(null)
        setDiff(null)
      }
    } catch (e) {
      setCommitResult({ ok: false, output: cleanError(e) })
    }
    setCommitting(false)
    reload()
  }

  const header = (
    <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-1.5 text-sm dark:border-zinc-800">
      <GitBranch size={14} className="shrink-0 text-zinc-500" />
      <span className="min-w-0 flex-1 truncate font-medium">
        {status?.isRepo ? (status.branch ?? '(losgelöster HEAD)') : 'Git'}
      </span>
      {status?.isRepo && status.upstream && (
        <span
          className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-500"
          title={`Upstream: ${status.upstream}`}
        >
          <span className="flex items-center" title="Commits vor dem Upstream">
            <ArrowUp size={12} />
            {status.ahead}
          </span>
          <span className="flex items-center" title="Commits hinter dem Upstream">
            <ArrowDown size={12} />
            {status.behind}
          </span>
        </span>
      )}
      <button
        type="button"
        title="Aktualisieren"
        onClick={reload}
        className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
      </button>
    </div>
  )

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <p className="px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      </div>
    )
  }
  if (!status) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <p className="px-3 py-2 text-xs text-zinc-500">Lade Git-Status …</p>
      </div>
    )
  }
  if (!status.gitAvailable || !status.isRepo) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="m-3 rounded-lg border border-zinc-200 p-3 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          {status.gitAvailable ? (
            <>
              <p className="font-medium text-zinc-800 dark:text-zinc-200">
                Dieser Ordner ist kein Git-Repository.
              </p>
              <p className="mt-1">
                Im Terminal-Tab mit <code className="font-mono">git init</code> ein Repository
                anlegen, um Änderungen zu verfolgen.
              </p>
            </>
          ) : (
            <>
              <p className="font-medium text-zinc-800 dark:text-zinc-200">
                Git wurde nicht gefunden.
              </p>
              <p className="mt-1">
                Bitte Git installieren (git-scm.com) und die App danach neu starten.
              </p>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div
        className={`overflow-y-auto py-1 ${selected ? 'max-h-[35%] min-h-20 shrink-0 border-b border-zinc-200 dark:border-zinc-800' : 'min-h-0 flex-1'}`}
      >
        {status.files.length === 0 && (
          <p className="px-3 py-2 text-xs text-zinc-500">Keine Änderungen – alles committet.</p>
        )}
        {status.files.map((file) => {
          const badge = STATUS_BADGE[file.status]
          const isSelected = selected?.path === file.path && selected.staged === file.staged
          const name = file.path.replace(/\/$/, '').split('/').pop() ?? file.path
          return (
            <button
              type="button"
              key={`${file.staged ? 'i' : 'w'}:${file.path}`}
              onClick={() => select(file)}
              title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
              className={`flex w-full items-center gap-2 px-3 py-0.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                isSelected ? 'bg-blue-50 dark:bg-blue-950' : ''
              }`}
            >
              <span
                title={badge.label}
                className={`w-3 shrink-0 text-center font-mono text-xs font-bold ${badge.className}`}
              >
                {badge.letter}
              </span>
              <span className="shrink-0">{name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">{file.path}</span>
              {file.staged && (
                <span className="shrink-0 rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-zinc-800">
                  gestaged
                </span>
              )}
            </button>
          )
        })}
      </div>

      {selected && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-1 text-xs dark:border-zinc-800">
            <span className="min-w-0 flex-1 truncate font-mono">
              {selected.path}
              {selected.staged ? ' (gestaged)' : ''}
            </span>
            <button
              type="button"
              title="Diff schließen"
              onClick={() => {
                setSelected(null)
                setDiff(null)
              }}
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <X size={14} />
            </button>
          </div>
          {diff?.error && (
            <p className="px-3 py-2 text-xs text-red-600 dark:text-red-400">{diff.error}</p>
          )}
          {diff && diff.text === null && !diff.error && (
            <p className="px-3 py-2 text-xs text-zinc-500">Lade Diff …</p>
          )}
          {diff?.text != null && <DiffView diff={diff.text} />}
        </div>
      )}

      <div className="shrink-0 border-t border-zinc-200 p-2 dark:border-zinc-800">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void commit()
          }}
          rows={2}
          placeholder="Commit-Nachricht (Strg+Enter zum Committen)"
          className="w-full resize-y rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
        />
        <button
          type="button"
          onClick={() => void commit()}
          disabled={!message.trim() || committing || status.files.length === 0}
          className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <GitCommitHorizontal size={16} />
          {committing ? 'Committe …' : 'Alle Änderungen committen'}
        </button>
        {commitResult && (
          <pre
            className={`mt-2 max-h-32 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap ${
              commitResult.ok
                ? 'bg-green-50 text-green-800 dark:bg-green-950/60 dark:text-green-300'
                : 'bg-red-50 text-red-800 dark:bg-red-950/60 dark:text-red-300'
            }`}
          >
            {commitResult.output ||
              (commitResult.ok ? 'Commit erstellt.' : 'Commit fehlgeschlagen.')}
          </pre>
        )}
      </div>
    </div>
  )
}
