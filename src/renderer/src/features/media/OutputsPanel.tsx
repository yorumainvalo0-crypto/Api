import { useEffect, useState } from 'react'
import { ImageOff, Images, Loader2, RefreshCw } from 'lucide-react'
import type { OutputFile } from '@shared/schemas/media'
import { fileUrl } from '@shared/ipc'
import { api } from '../../lib/api'
import { cleanError } from '../../components/ModelPicker'
import { formatSize } from '../project/highlight'
import { PreviewKindIcon } from './FilePreview'
import { CHECKERBOARD } from './ImageViewer'
import { MediaModal } from './MediaModal'
import { fileExtension, previewKind } from './media-utils'

type ListState =
  | { status: 'loading'; files: OutputFile[] }
  | { status: 'ready'; files: OutputFile[] }
  | { status: 'error'; files: OutputFile[]; message: string }

/**
 * Right-side panel with the files the agent produced in a chat (newest first). Refetches when
 * `chatId` or `refreshKey` changes; clicking a tile opens it in a MediaModal.
 */
export function OutputsPanel(props: {
  chatId: string
  refreshKey: number
  onUseAsInput?: (path: string) => void
}) {
  const { chatId, refreshKey, onUseAsInput } = props
  const [state, setState] = useState<ListState>({ status: 'loading', files: [] })
  const [manualRefresh, setManualRefresh] = useState(0)
  const [selected, setSelected] = useState<OutputFile | null>(null)

  useEffect(() => {
    let cancelled = false
    api.invoke('outputs:list', { chatId }).then(
      (files) => {
        if (cancelled) return
        const sorted = [...files].sort((a, b) => b.modifiedAt - a.modifiedAt)
        setState({ status: 'ready', files: sorted })
      },
      (e: unknown) => {
        if (!cancelled)
          setState((s) => ({ status: 'error', files: s.files, message: cleanError(e) }))
      },
    )
    return () => {
      cancelled = true
    }
  }, [chatId, refreshKey, manualRefresh])

  // Drop the files of the previous chat right away instead of showing them while loading.
  const [shownChat, setShownChat] = useState(chatId)
  if (shownChat !== chatId) {
    setShownChat(chatId)
    setState({ status: 'loading', files: [] })
    setSelected(null)
  }

  const { files } = state

  return (
    <aside className="flex h-full w-[420px] shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <Images size={14} className="text-zinc-500" />
        <span className="text-sm font-medium">Ergebnisse</span>
        {files.length > 0 && <span className="text-xs text-zinc-500">{files.length}</span>}
        <span className="flex-1" />
        <button
          type="button"
          title="Aktualisieren"
          aria-label="Aktualisieren"
          onClick={() => {
            setState((s) => ({ status: 'loading', files: s.files }))
            setManualRefresh((n) => n + 1)
          }}
          className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <RefreshCw size={14} className={state.status === 'loading' ? 'animate-spin' : ''} />
        </button>
      </div>

      {state.status === 'error' && (
        <p className="px-3 py-2 text-xs text-red-600 dark:text-red-400">{state.message}</p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {files.length === 0 && state.status === 'loading' && (
          <p className="flex items-center gap-2 text-xs text-zinc-500">
            <Loader2 size={12} className="animate-spin" /> Lade …
          </p>
        )}
        {files.length === 0 && state.status === 'ready' && (
          <p className="px-4 py-10 text-center text-sm text-zinc-500">
            Noch keine Ergebnisse – erzeugte Bilder, 3D-Modelle und Dateien erscheinen hier.
          </p>
        )}
        {files.length > 0 && (
          <ul className="grid grid-cols-3 gap-2">
            {files.map((file) => (
              <li key={file.path}>
                <OutputTile file={file} onOpen={() => setSelected(file)} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected && (
        <MediaModal
          file={selected}
          onClose={() => setSelected(null)}
          {...(onUseAsInput ? { onUseAsInput } : {})}
        />
      )}
    </aside>
  )
}

function OutputTile(props: { file: OutputFile; onOpen: () => void }) {
  const { file } = props
  const kind = previewKind(file)
  const ext = fileExtension(file.name)
  const [broken, setBroken] = useState(false)
  const date = new Date(file.modifiedAt).toLocaleString('de-DE', {
    dateStyle: 'short',
    timeStyle: 'short',
  })

  return (
    <button
      type="button"
      onClick={props.onOpen}
      title={`${file.name}\n${formatSize(file.size)} · ${date}`}
      className="group flex w-full flex-col overflow-hidden rounded-lg border border-zinc-200 text-left hover:border-blue-400 focus-visible:border-blue-500 focus-visible:outline-none dark:border-zinc-800 dark:hover:border-blue-500"
    >
      <div
        className={`flex aspect-square w-full items-center justify-center overflow-hidden ${
          kind === 'image' && !broken ? CHECKERBOARD : 'bg-zinc-100 dark:bg-zinc-900'
        }`}
      >
        {kind === 'image' && !broken ? (
          <img
            src={fileUrl(file.path)}
            alt={file.name}
            loading="lazy"
            draggable={false}
            onError={() => setBroken(true)}
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
          />
        ) : kind === 'image' ? (
          <ImageOff size={24} className="text-zinc-400" />
        ) : (
          <div
            className={`flex flex-col items-center gap-1 ${
              kind === 'model3d' ? 'text-blue-500 dark:text-blue-400' : 'text-zinc-400'
            }`}
          >
            <PreviewKindIcon file={file} size={28} />
            {ext && (
              <span className="text-[10px] font-semibold tracking-wide uppercase">{ext}</span>
            )}
          </div>
        )}
      </div>
      <span className="truncate px-1.5 py-1 text-xs text-zinc-700 dark:text-zinc-300">
        {file.name}
      </span>
    </button>
  )
}
