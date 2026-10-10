import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, RefreshCw, X } from 'lucide-react'
import type { DirEntry, FileContent } from '@shared/schemas/project'
import { api } from '../../lib/api'
import { cleanError } from '../../components/ModelPicker'
import { formatSize, highlightCode } from './highlight'

type OpenFile =
  | { relPath: string; data: FileContent; error: null }
  | { relPath: string; data: null; error: string | null }

/** Lazy-expanding file tree with a read-only, syntax-highlighted viewer. */
export function FilesTab(props: { projectPath: string }) {
  const { projectPath } = props
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [openFile, setOpenFile] = useState<OpenFile | null>(null)

  const loadDir = useCallback(
    async (relPath: string) => {
      const list = await api.invoke('project:list-dir', { projectPath, relPath })
      setChildren((prev) => ({ ...prev, [relPath]: list }))
      return list
    },
    [projectPath],
  )

  const loadFile = useCallback(
    async (relPath: string) => {
      try {
        const data = await api.invoke('project:read-file', { projectPath, relPath })
        setOpenFile({ relPath, data, error: null })
      } catch (e) {
        setOpenFile({ relPath, data: null, error: cleanError(e) })
      }
    },
    [projectPath],
  )

  useEffect(() => {
    let cancelled = false
    api.invoke('project:list-dir', { projectPath, relPath: '' }).then(
      (list) => {
        if (cancelled) return
        setChildren((prev) => ({ ...prev, '': list }))
        setError(null)
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      },
    )
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const toggle = (entry: DirEntry) => {
    const isOpen = expanded.has(entry.relPath)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (isOpen) next.delete(entry.relPath)
      else next.add(entry.relPath)
      return next
    })
    if (!isOpen && !children[entry.relPath]) {
      loadDir(entry.relPath).catch((e: unknown) => setError(cleanError(e)))
    }
  }

  const open = (entry: DirEntry) => {
    setOpenFile({ relPath: entry.relPath, data: null, error: null })
    void loadFile(entry.relPath)
  }

  const refresh = async () => {
    setRefreshing(true)
    try {
      await loadDir('')
      setError(null)
    } catch (e) {
      setError(cleanError(e))
    }
    // Reload expanded folders; drop the ones that no longer exist.
    const dirs = [...expanded]
    const results = await Promise.allSettled(dirs.map((d) => loadDir(d)))
    const gone = dirs.filter((_, i) => results[i]?.status === 'rejected')
    if (gone.length) {
      setExpanded((prev) => new Set([...prev].filter((d) => !gone.includes(d))))
      setChildren((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([dir]) => !gone.includes(dir))),
      )
    }
    if (openFile) await loadFile(openFile.relPath)
    setRefreshing(false)
  }

  const renderDir = (relPath: string, depth: number): ReactNode => {
    const list = children[relPath]
    if (!list) return <TreeHint depth={depth}>Lade …</TreeHint>
    if (list.length === 0) return <TreeHint depth={depth}>(leer)</TreeHint>
    return list.map((entry) => {
      const isOpen = expanded.has(entry.relPath)
      const active = openFile?.relPath === entry.relPath
      return (
        <Fragment key={entry.relPath}>
          <button
            type="button"
            onClick={() => (entry.isDir ? toggle(entry) : open(entry))}
            title={entry.isDir ? entry.relPath : `${entry.relPath} (${formatSize(entry.size)})`}
            style={{ paddingLeft: 6 + depth * 14 }}
            className={`flex w-full items-center gap-1 py-0.5 pr-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
              active ? 'bg-blue-50 dark:bg-blue-950' : ''
            }`}
          >
            {entry.isDir ? (
              <>
                {isOpen ? (
                  <ChevronDown size={14} className="shrink-0 text-zinc-400" />
                ) : (
                  <ChevronRight size={14} className="shrink-0 text-zinc-400" />
                )}
                {isOpen ? (
                  <FolderOpen size={14} className="shrink-0 text-amber-500" />
                ) : (
                  <Folder size={14} className="shrink-0 text-amber-500" />
                )}
              </>
            ) : (
              <>
                <span className="w-[14px] shrink-0" />
                <File size={14} className="shrink-0 text-zinc-400" />
              </>
            )}
            <span className="truncate">{entry.name}</span>
          </button>
          {entry.isDir && isOpen && renderDir(entry.relPath, depth + 1)}
        </Fragment>
      )
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-500" title={projectPath}>
          {projectPath}
        </span>
        <button
          type="button"
          title="Aktualisieren"
          onClick={() => void refresh()}
          className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>
      {error && <p className="px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div
        className={`overflow-y-auto py-1 ${openFile ? 'max-h-[40%] min-h-24 shrink-0 border-b border-zinc-200 dark:border-zinc-800' : 'min-h-0 flex-1'}`}
      >
        {renderDir('', 0)}
      </div>
      {openFile && <FileViewer file={openFile} onClose={() => setOpenFile(null)} />}
    </div>
  )
}

function TreeHint(props: { depth: number; children: ReactNode }) {
  return (
    <div style={{ paddingLeft: 26 + props.depth * 14 }} className="py-0.5 text-xs text-zinc-400">
      {props.children}
    </div>
  )
}

function FileViewer(props: { file: OpenFile; onClose: () => void }) {
  const { file } = props
  const name = file.relPath.split('/').pop() ?? file.relPath
  const content = file.data && !file.data.binary ? file.data.content : null
  const html = useMemo(
    () => (content === null ? '' : highlightCode(content, name)),
    [content, name],
  )
  const lineCount = useMemo(() => (content === null ? 0 : content.split('\n').length), [content])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-1.5 text-xs dark:border-zinc-800">
        <span className="min-w-0 flex-1 truncate font-mono" title={file.relPath}>
          {file.relPath}
        </span>
        {file.data && <span className="shrink-0 text-zinc-500">{formatSize(file.data.size)}</span>}
        <button
          type="button"
          title="Schließen"
          onClick={props.onClose}
          className="rounded p-0.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <X size={14} />
        </button>
      </div>
      {file.error && (
        <p className="px-3 py-2 text-xs text-red-600 dark:text-red-400">{file.error}</p>
      )}
      {!file.data && !file.error && <p className="px-3 py-2 text-xs text-zinc-500">Lade …</p>}
      {file.data?.binary && (
        <p className="px-3 py-2 text-xs text-zinc-500">
          Binärdatei – keine Vorschau ({formatSize(file.data.size)}).
        </p>
      )}
      {file.data?.truncated && !file.data.binary && (
        <p className="bg-amber-50 px-3 py-1 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          Datei ist größer als 1 MB – nur der Anfang wird angezeigt.
        </p>
      )}
      {content !== null && (
        <div className="min-h-0 flex-1 overflow-auto bg-zinc-900 text-zinc-100">
          <div className="flex min-w-max font-mono text-xs leading-5">
            <pre className="sticky left-0 shrink-0 bg-zinc-900 px-2 py-2 text-right text-zinc-500 select-none">
              {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
            </pre>
            <pre className="py-2 pr-4 pl-2">
              <code
                className="hljs bg-transparent! p-0!"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
