import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Download,
  ExternalLink,
  File,
  FileCode,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Box,
  Loader2,
} from 'lucide-react'
import type { AttachmentKind } from '@shared/schemas/chat'
import { fileUrl } from '@shared/ipc'
import { api } from '../../lib/api'
import { cleanError } from '../../components/ModelPicker'
import { formatSize, highlightCode } from '../project/highlight'
import { ImageViewer } from './ImageViewer'
import { ModelViewer } from './ModelViewer'
import { fileExtension, previewKind, type PreviewKind } from './media-utils'

export interface PreviewFile {
  path: string
  name: string
  kind: AttachmentKind
  mimeType: string
}

/** Text files are only shown up to this size. */
const TEXT_PREVIEW_LIMIT = 512 * 1024

const KIND_ICONS: Record<PreviewKind, typeof File> = {
  image: ImageIcon,
  model3d: Box,
  pdf: FileText,
  text: FileCode,
  file: File,
}

/** Icon for a file's preview kind (used by thumbnails and chips). */
export function PreviewKindIcon(props: { file: PreviewFile; size?: number; className?: string }) {
  const Icon = KIND_ICONS[previewKind(props.file)]
  return <Icon size={props.size ?? 16} className={props.className} />
}

/**
 * Viewer for one file: image, 3D model, text/code or a generic card, with a toolbar for
 * "save as", "show in folder" and "open externally". Fills its parent (flex column).
 */
export function FilePreview(props: { file: PreviewFile; toolbarExtra?: ReactNode }) {
  const { file } = props
  const kind = previewKind(file)

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
        <PreviewKindIcon file={file} size={14} className="shrink-0 text-zinc-400" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={file.path}>
          {file.name}
        </span>
        <FileActions path={file.path} />
        {props.toolbarExtra}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {kind === 'image' && <ImageViewer path={file.path} name={file.name} />}
        {kind === 'model3d' && <ModelViewer path={file.path} name={file.name} />}
        {kind === 'text' && <TextPreview key={file.path} file={file} />}
        {kind === 'pdf' && (
          <NoPreview
            file={file}
            text="PDF-Dokumente werden im Standardprogramm geöffnet (eingebettete Vorschau ist aus Sicherheitsgründen deaktiviert)."
          />
        )}
        {kind === 'file' && (
          <NoPreview file={file} text="Für diesen Dateityp gibt es keine Vorschau." />
        )}
      </div>
    </div>
  )
}

type ActionId = 'save' | 'folder' | 'external'

/** Toolbar buttons for a file on disk, with inline error/success feedback. */
export function FileActions(props: { path: string }) {
  const { path } = props
  const [busy, setBusy] = useState<ActionId | null>(null)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)

  const run = async (id: ActionId) => {
    setBusy(id)
    setMessage(null)
    try {
      if (id === 'save') {
        const { savedTo } = await api.invoke('files:save-as', { path })
        if (savedTo) setMessage({ error: false, text: `Gespeichert: ${savedTo}` })
      } else if (id === 'folder') {
        await api.invoke('files:show-in-folder', { path })
      } else {
        const { ok } = await api.invoke('files:open-external', { path })
        if (!ok) setMessage({ error: true, text: 'Datei konnte nicht geöffnet werden.' })
      }
    } catch (e) {
      setMessage({ error: true, text: cleanError(e) })
    } finally {
      setBusy(null)
    }
  }

  const button = (id: ActionId, title: string, icon: ReactNode) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={busy !== null}
      onClick={() => void run(id)}
      className="rounded-md p-1 text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      {busy === id ? <Loader2 size={14} className="animate-spin" /> : icon}
    </button>
  )

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {message && (
        <span
          title={message.text}
          className={`max-w-56 truncate text-xs ${
            message.error
              ? 'text-red-600 dark:text-red-400'
              : 'text-emerald-600 dark:text-emerald-400'
          }`}
        >
          {message.text}
        </span>
      )}
      {button('save', 'Speichern unter …', <Download size={14} />)}
      {button('folder', 'Im Ordner zeigen', <FolderOpen size={14} />)}
      {button('external', 'Extern öffnen', <ExternalLink size={14} />)}
    </div>
  )
}

type TextState =
  | { status: 'loading' }
  | { status: 'ready'; text: string; size: number; truncated: boolean }
  | { status: 'error'; message: string }

function TextPreview(props: { file: PreviewFile }) {
  const { file } = props
  const [state, setState] = useState<TextState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const response = await fetch(fileUrl(file.path))
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      const text = await blob.slice(0, TEXT_PREVIEW_LIMIT).text()
      return { text, size: blob.size, truncated: blob.size > TEXT_PREVIEW_LIMIT }
    }
    load().then(
      (result) => {
        if (!cancelled) setState({ status: 'ready', ...result })
      },
      (e: unknown) => {
        if (!cancelled) setState({ status: 'error', message: cleanError(e) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [file.path])

  const text = state.status === 'ready' ? state.text : null
  const html = useMemo(
    () => (text === null ? '' : highlightCode(text, file.name)),
    [text, file.name],
  )

  if (state.status === 'loading') {
    return (
      <p className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-500">
        <Loader2 size={12} className="animate-spin" /> Lade …
      </p>
    )
  }
  if (state.status === 'error') {
    return (
      <p className="px-3 py-2 text-xs text-red-600 dark:text-red-400">
        Datei konnte nicht gelesen werden: {state.message}
      </p>
    )
  }
  return (
    <>
      {state.truncated && (
        <p className="shrink-0 bg-amber-50 px-3 py-1 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          Datei ist {formatSize(state.size)} groß – nur die ersten {formatSize(TEXT_PREVIEW_LIMIT)}{' '}
          werden angezeigt.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto bg-zinc-900 text-zinc-100">
        <pre className="min-w-max px-3 py-2 font-mono text-xs leading-5">
          <code className="hljs bg-transparent! p-0!" dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </div>
    </>
  )
}

function NoPreview(props: { file: PreviewFile; text: string }) {
  const { file } = props
  const [error, setError] = useState<string | null>(null)
  const ext = fileExtension(file.name)

  const openExternal = async () => {
    setError(null)
    try {
      const { ok } = await api.invoke('files:open-external', { path: file.path })
      if (!ok) setError('Datei konnte nicht geöffnet werden.')
    } catch (e) {
      setError(cleanError(e))
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex h-16 w-16 flex-col items-center justify-center rounded-xl bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
        <PreviewKindIcon file={file} size={26} />
        {ext && <span className="mt-0.5 text-[10px] font-semibold uppercase">{ext}</span>}
      </div>
      <div className="max-w-full">
        <p className="truncate text-sm font-medium">{file.name}</p>
        {file.mimeType && <p className="text-xs text-zinc-500">{file.mimeType}</p>}
      </div>
      <p className="max-w-sm text-xs text-zinc-500">{props.text}</p>
      <button
        type="button"
        onClick={() => void openExternal()}
        className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
      >
        <ExternalLink size={14} />
        Extern öffnen
      </button>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
