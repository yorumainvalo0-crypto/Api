import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { ImageOff, Maximize, ZoomIn, ZoomOut } from 'lucide-react'
import { fileUrl } from '@shared/ipc'
import { zoomAt, type ZoomState } from './media-utils'

const FIT: ZoomState = { scale: 1, x: 0, y: 0 }
const BUTTON_STEP = 1.25

/** Checkerboard pattern that makes transparent areas visible (light and dark theme). */
export const CHECKERBOARD =
  'bg-[image:repeating-conic-gradient(#e4e4e7_0_25%,#ffffff_0_50%)] bg-[length:16px_16px] ' +
  'dark:bg-[image:repeating-conic-gradient(#27272a_0_25%,#18181b_0_50%)]'

/** Fit-to-container image with wheel/button zoom and drag-to-pan. */
export function ImageViewer(props: { path: string; name: string }) {
  // Keyed by path so zoom/error state resets when another image is shown.
  return <ImageView key={props.path} path={props.path} name={props.name} />
}

function ImageView(props: { path: string; name: string }) {
  const { path, name } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState<ZoomState>(FIT)
  const [failed, setFailed] = useState(false)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)

  // Wheel zoom needs a non-passive listener to prevent page scrolling.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left - rect.width / 2
      const py = e.clientY - rect.top - rect.height / 2
      const factor = Math.exp(-e.deltaY * 0.0015)
      setZoom((z) => zoomAt(z, factor, px, py))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (d?.id !== e.pointerId) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    drag.current = { id: d.id, x: e.clientX, y: e.clientY }
    setZoom((z) => ({ ...z, x: z.x + dx, y: z.y + dy }))
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null
  }

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => setZoom(FIT)}
        className={`relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing ${CHECKERBOARD}`}
      >
        {failed ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-zinc-500">
            <ImageOff size={28} />
            Bild konnte nicht geladen werden.
          </div>
        ) : (
          <img
            src={fileUrl(path)}
            alt={name}
            draggable={false}
            onLoad={(e) =>
              setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
            }
            onError={() => setFailed(true)}
            style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}
            className="absolute inset-0 h-full w-full object-contain [image-rendering:auto]"
          />
        )}
      </div>
      {!failed && (
        <div className="absolute right-2 bottom-2 flex items-center gap-0.5 rounded-md border border-zinc-200 bg-white/90 p-0.5 text-xs text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-300">
          {natural && (
            <span className="px-1.5 text-zinc-500" title="Originalgröße">
              {natural.w} × {natural.h}
            </span>
          )}
          <ViewerButton
            title="Verkleinern"
            onClick={() => setZoom((z) => zoomAt(z, 1 / BUTTON_STEP))}
          >
            <ZoomOut size={14} />
          </ViewerButton>
          <span className="w-11 text-center tabular-nums">{Math.round(zoom.scale * 100)} %</span>
          <ViewerButton title="Vergrößern" onClick={() => setZoom((z) => zoomAt(z, BUTTON_STEP))}>
            <ZoomIn size={14} />
          </ViewerButton>
          <ViewerButton title="Einpassen" onClick={() => setZoom(FIT)}>
            <Maximize size={14} />
          </ViewerButton>
        </div>
      )}
    </div>
  )
}

export function ViewerButton(props: {
  title: string
  onClick: () => void
  active?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.active}
      onClick={props.onClick}
      className={`rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
        props.active ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300' : ''
      }`}
    >
      {props.children}
    </button>
  )
}
