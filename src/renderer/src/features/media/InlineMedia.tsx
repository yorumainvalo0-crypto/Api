import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Box, ImageOff, Maximize2 } from 'lucide-react'
import type { AttachmentKind } from '@shared/schemas/chat'
import { fileUrl } from '@shared/ipc'
import { PreviewKindIcon, type PreviewFile } from './FilePreview'
import { CHECKERBOARD } from './ImageViewer'
import { MediaModal } from './MediaModal'
import { ModelViewer } from './ModelViewer'
import { guessMimeType, previewKind } from './media-utils'

/**
 * Compact preview of a produced/attached file inside a chat message: image thumbnail, small 3D
 * viewer or a file chip. Everything opens a large MediaModal on demand.
 */
export function InlineMedia(props: {
  path: string
  name: string
  kind: AttachmentKind
  mimeType?: string
  onUseAsInput?: (path: string) => void
}) {
  const { path, name, kind, onUseAsInput } = props
  const file: PreviewFile = { path, name, kind, mimeType: props.mimeType ?? guessMimeType(name) }
  const preview = previewKind(file)
  const [open, setOpen] = useState(false)
  const [broken, setBroken] = useState(false)

  const modal = open && (
    <MediaModal
      file={file}
      onClose={() => setOpen(false)}
      {...(onUseAsInput ? { onUseAsInput } : {})}
    />
  )

  if (preview === 'image') {
    return (
      <>
        <button
          type="button"
          title={`${name} – vergrößern`}
          onClick={() => setOpen(true)}
          className={`block max-w-[360px] overflow-hidden rounded-lg border border-zinc-200 hover:border-blue-400 dark:border-zinc-800 dark:hover:border-blue-500 ${CHECKERBOARD}`}
        >
          {broken ? (
            <span className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-500">
              <ImageOff size={14} /> {name}
            </span>
          ) : (
            <img
              src={fileUrl(path)}
              alt={name}
              loading="lazy"
              draggable={false}
              onError={() => setBroken(true)}
              className="block max-h-[360px] max-w-full object-contain"
            />
          )}
        </button>
        {modal}
      </>
    )
  }

  if (preview === 'model3d') {
    return (
      <>
        <div className="w-full max-w-[480px] overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-900">
            <Box size={13} className="shrink-0 text-blue-500" />
            <span className="min-w-0 flex-1 truncate font-mono" title={path}>
              {name}
            </span>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Maximize2 size={12} />
              Groß öffnen
            </button>
          </div>
          <LazyWhenVisible height={260}>
            {/* Unmounted while the modal is open to keep only one WebGL context per model. */}
            {!open && <ModelViewer path={path} name={name} height={260} />}
          </LazyWhenVisible>
        </div>
        {modal}
      </>
    )
  }

  return (
    <>
      <button
        type="button"
        title={path}
        onClick={() => setOpen(true)}
        className="flex max-w-[360px] items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm hover:border-blue-400 dark:border-zinc-800 dark:hover:border-blue-500"
      >
        <PreviewKindIcon file={file} size={16} className="shrink-0 text-zinc-500" />
        <span className="min-w-0 truncate">{name}</span>
      </button>
      {modal}
    </>
  )
}

/**
 * Renders children only while near the viewport. Long chats with many 3D models would otherwise
 * exceed the browser's limit of simultaneous WebGL contexts.
 */
function LazyWhenVisible(props: { height: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (entry) setVisible(entry.isIntersecting)
      },
      { rootMargin: '300px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      style={{ height: props.height }}
      className="bg-gradient-to-b from-zinc-100 to-zinc-200 dark:from-zinc-900 dark:to-zinc-950"
    >
      {visible && props.children}
    </div>
  )
}
