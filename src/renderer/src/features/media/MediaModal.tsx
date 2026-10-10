import { useEffect, useEffectEvent } from 'react'
import { createPortal } from 'react-dom'
import { CornerDownLeft, X } from 'lucide-react'
import { FilePreview, type PreviewFile } from './FilePreview'

/** Large modal with a FilePreview. Escape or a click on the backdrop closes it. */
export function MediaModal(props: {
  file: PreviewFile
  onClose: () => void
  onUseAsInput?: (path: string) => void
}) {
  const { file, onClose, onUseAsInput } = props
  const close = useEffectEvent(onClose)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={file.name}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    >
      <div className="flex h-[88vh] w-[min(1200px,94vw)] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
        <FilePreview
          file={file}
          toolbarExtra={
            <>
              {onUseAsInput && (
                <button
                  type="button"
                  onClick={() => {
                    onUseAsInput(file.path)
                    onClose()
                  }}
                  className="ml-1 flex shrink-0 items-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700"
                >
                  <CornerDownLeft size={13} />
                  Als Eingabe verwenden
                </button>
              )}
              <button
                type="button"
                title="Schließen (Esc)"
                aria-label="Schließen"
                onClick={onClose}
                className="ml-1 rounded-md p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <X size={16} />
              </button>
            </>
          }
        />
      </div>
    </div>,
    document.body,
  )
}
