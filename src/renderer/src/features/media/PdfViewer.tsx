import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  FileWarning,
  Loader2,
  Maximize,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { fileUrl } from '@shared/ipc'
import { cleanError } from '../../components/ModelPicker'
import { ViewerButton } from './ImageViewer'
import {
  canvasRenderScale,
  clampPage,
  clampPdfZoom,
  columnHeight,
  currentPageAt,
  fitWidthZoom,
  formatZoomPercent,
  pageLeft,
  pageTops,
  PDF_CSS_UNITS,
  PDF_PAGE_GAP,
  stepPdfZoom,
} from './pdf-utils'

GlobalWorkerOptions.workerSrc = workerUrl

/** Page size in PDF points (rotation applied). */
interface PageSize {
  w: number
  h: number
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; doc: PDFDocumentProxy; first: PageSize }
  | { status: 'error'; message: string }

/** How many page sizes are read per batch while the document is open. */
const SIZE_BATCH = 50

/** In-app PDF viewer: continuous scrolling, lazily rendered pages, zoom and page navigation. */
export function PdfViewer(props: { path: string; name: string }) {
  // Keyed by path so document, zoom and scroll state reset when another PDF is shown.
  return <PdfView key={props.path} path={props.path} name={props.name} />
}

function errorMessage(e: unknown): string {
  if (e instanceof Error && e.name === 'PasswordException') {
    return 'Das PDF ist passwortgeschützt und kann nicht angezeigt werden.'
  }
  if (e instanceof Error && e.name === 'InvalidPDFException') {
    return 'Die Datei ist kein gültiges PDF-Dokument.'
  }
  return cleanError(e)
}

function PdfView(props: { path: string; name: string }) {
  const { path } = props
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    let task: ReturnType<typeof getDocument> | null = null
    const load = async () => {
      const response = await fetch(fileUrl(path)).catch(() => {
        throw new Error('Die Datei konnte nicht gelesen werden.')
      })
      if (!response.ok)
        throw new Error(`Die Datei konnte nicht gelesen werden (HTTP ${response.status}).`)
      const data = new Uint8Array(await response.arrayBuffer())
      if (cancelled) return null
      task = getDocument({ data })
      const doc = await task.promise
      const view = (await doc.getPage(1)).getViewport({ scale: 1 })
      return { doc, first: { w: view.width, h: view.height } }
    }
    load().then(
      (result) => {
        if (!cancelled && result) setState({ status: 'ready', ...result })
      },
      (e: unknown) => {
        if (!cancelled) setState({ status: 'error', message: errorMessage(e) })
      },
    )
    return () => {
      cancelled = true
      // Also destroys the document and releases the worker.
      void task?.destroy()
    }
  }, [path])

  if (state.status === 'loading') {
    return (
      <p className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-500">
        <Loader2 size={12} className="animate-spin" /> PDF wird geladen …
      </p>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-zinc-500">
        <FileWarning size={28} />
        <p>PDF konnte nicht geladen werden.</p>
        <p className="max-w-sm text-xs text-red-600 dark:text-red-400">{state.message}</p>
      </div>
    )
  }
  return <PdfPages doc={state.doc} first={state.first} />
}

function PdfPages(props: { doc: PDFDocumentProxy; first: PageSize }) {
  const { doc, first } = props
  const count = doc.numPages
  // The scroll container is kept in state (effects and page observers depend on it) and in a ref
  // (for imperative scrolling).
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const attachScroll = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el
    setScrollEl(el)
  }, [])
  const [viewportWidth, setViewportWidth] = useState(0)
  const [zoomMode, setZoomMode] = useState<number | 'fit'>('fit')
  const [page, setPage] = useState(1)
  // Real sizes arrive in the background; until then every page is assumed to look like page 1.
  const [loadedSizes, setLoadedSizes] = useState<PageSize[]>([])
  // Scroll position (as a fraction of the content) to restore after the next zoom change.
  const anchor = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      for (let start = 1; start <= count; start += SIZE_BATCH) {
        const numbers = Array.from(
          { length: Math.min(SIZE_BATCH, count - start + 1) },
          (_, i) => start + i,
        )
        const batch = await Promise.all(
          numbers.map(async (n) => {
            const view = (await doc.getPage(n)).getViewport({ scale: 1 })
            return { w: view.width, h: view.height }
          }),
        )
        if (cancelled) return
        setLoadedSizes((prev) => prev.concat(batch))
      }
    }
    // Failing here only means the estimated sizes stay in place (e.g. document destroyed).
    run().catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [doc, count])

  useEffect(() => {
    if (!scrollEl) return
    const observer = new ResizeObserver(() => setViewportWidth(scrollEl.clientWidth))
    observer.observe(scrollEl)
    return () => observer.disconnect()
  }, [scrollEl])

  const zoom =
    zoomMode === 'fit' ? fitWidthZoom(viewportWidth, first.w, PDF_PAGE_GAP) : clampPdfZoom(zoomMode)

  const sizes = useMemo(
    () => Array.from({ length: count }, (_, i) => loadedSizes[i] ?? first),
    [count, loadedSizes, first],
  )
  const heights = useMemo(() => sizes.map((s) => s.h * zoom * PDF_CSS_UNITS), [sizes, zoom])
  const tops = useMemo(() => pageTops(heights), [heights])

  // The page indicator follows scrolling.
  useEffect(() => {
    if (!scrollEl) return
    const update = () => {
      setPage(currentPageAt(tops, heights, scrollEl.scrollTop, scrollEl.clientHeight))
    }
    scrollEl.addEventListener('scroll', update, { passive: true })
    const frame = requestAnimationFrame(update)
    return () => {
      scrollEl.removeEventListener('scroll', update)
      cancelAnimationFrame(frame)
    }
  }, [scrollEl, tops, heights])

  // Keep the reading position when the zoom level changes.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || anchor.current === null) return
    el.scrollTop = anchor.current * el.scrollHeight
    anchor.current = null
  }, [zoom])

  const changeZoom = (next: number | 'fit') => {
    const el = scrollRef.current
    if (el && el.scrollHeight > 0) anchor.current = el.scrollTop / el.scrollHeight
    setZoomMode(next)
  }

  const goToPage = useCallback(
    (target: number) => {
      const index = clampPage(target, count) - 1
      scrollRef.current?.scrollTo({ top: Math.max(0, (tops[index] ?? 0) - PDF_PAGE_GAP) })
    },
    [tops, count],
  )

  const widest = sizes.reduce((max, s) => Math.max(max, s.w), 0) * zoom * PDF_CSS_UNITS
  const contentWidth = Math.max(viewportWidth, widest + PDF_PAGE_GAP * 2)
  const contentHeight = columnHeight(heights)

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-zinc-200 px-2 py-1 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
        <ViewerButton title="Vorherige Seite" onClick={() => goToPage(page - 1)}>
          <ChevronUp size={14} />
        </ViewerButton>
        <span className="min-w-16 text-center tabular-nums" title="Aktuelle Seite">
          {page} / {count}
        </span>
        <ViewerButton title="Nächste Seite" onClick={() => goToPage(page + 1)}>
          <ChevronDown size={14} />
        </ViewerButton>
        <span className="flex-1" />
        <ViewerButton title="Verkleinern" onClick={() => changeZoom(stepPdfZoom(zoom, 'out'))}>
          <ZoomOut size={14} />
        </ViewerButton>
        <span className="w-11 text-center tabular-nums">{formatZoomPercent(zoom)}</span>
        <ViewerButton title="Vergrößern" onClick={() => changeZoom(stepPdfZoom(zoom, 'in'))}>
          <ZoomIn size={14} />
        </ViewerButton>
        <ViewerButton
          title="Seitenbreite einpassen"
          active={zoomMode === 'fit'}
          onClick={() => changeZoom('fit')}
        >
          <Maximize size={14} />
        </ViewerButton>
      </div>
      <div ref={attachScroll} className="min-h-0 flex-1 overflow-auto bg-zinc-200 dark:bg-zinc-900">
        <div className="relative" style={{ width: contentWidth, height: contentHeight }}>
          {sizes.map((size, i) => (
            <PdfPage
              key={i}
              doc={doc}
              pageNumber={i + 1}
              root={scrollEl}
              top={tops[i] ?? 0}
              left={pageLeft(viewportWidth, size.w * zoom * PDF_CSS_UNITS)}
              width={size.w * zoom * PDF_CSS_UNITS}
              height={heights[i] ?? 0}
              zoom={zoom}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/** One page: a white placeholder that renders its canvas once it is near the viewport. */
function PdfPage(props: {
  doc: PDFDocumentProxy
  pageNumber: number
  root: HTMLDivElement | null
  top: number
  left: number
  width: number
  height: number
  zoom: number
}) {
  const { doc, pageNumber, root, zoom, width, height } = props
  const frameRef = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)

  useEffect(() => {
    const frame = frameRef.current
    if (!root || !frame) return
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1]
        if (last) setNear(last.isIntersecting)
      },
      { root, rootMargin: '100% 0px' },
    )
    observer.observe(frame)
    return () => observer.disconnect()
  }, [root])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    if (!near) {
      // Free the bitmap of pages that scrolled far away.
      frame.replaceChildren()
      return
    }
    let cancelled = false
    let renderTask: { cancel: () => void } | null = null
    const draw = async () => {
      const page = await doc.getPage(pageNumber)
      if (cancelled) return
      const pixelRatio = canvasRenderScale(width, height, window.devicePixelRatio)
      const viewport = page.getViewport({ scale: zoom * PDF_CSS_UNITS * pixelRatio })
      // Render off-screen and swap, so zooming does not flash a blank page.
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.className = 'block h-full w-full'
      const task = page.render({ canvas, viewport })
      renderTask = task
      await task.promise
      if (!cancelled) frame.replaceChildren(canvas)
    }
    draw().catch((e: unknown) => {
      // A cancelled render rejects with RenderingCancelledException; ignore it.
      if (!cancelled && !(e instanceof Error && e.name === 'RenderingCancelledException')) {
        frame.replaceChildren()
      }
    })
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [doc, pageNumber, near, zoom, width, height])

  return (
    <div
      ref={frameRef}
      role="img"
      aria-label={`Seite ${pageNumber}`}
      className="absolute bg-white shadow-md ring-1 ring-zinc-300 dark:ring-zinc-700"
      style={{ top: props.top, left: props.left, width, height }}
    />
  )
}
