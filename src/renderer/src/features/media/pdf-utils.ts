/*
 * Pure helpers for the PDF viewer (no DOM, no pdf.js) so they can be unit-tested in Node.
 */

/** CSS pixels per PDF point: 100 % shows the page at its physical size (96 dpi). */
export const PDF_CSS_UNITS = 96 / 72

export const PDF_MIN_ZOOM = 0.25
export const PDF_MAX_ZOOM = 5

/** Zoom levels the zoom buttons step through (1 = 100 %). */
export const PDF_ZOOM_STEPS: readonly number[] = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
]

/** Canvases are never allocated with more pixels than this (memory / GPU limits). */
export const PDF_MAX_CANVAS_PIXELS = 16 * 1024 * 1024

/** Space between pages and around the page column, in CSS pixels. */
export const PDF_PAGE_GAP = 12

export function clampPdfZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, zoom))
}

/**
 * Next zoom level above/below `current` (clamped to the supported range). Levels closer than 5 %
 * are skipped so a click always makes a visible difference, even right after fit-width.
 */
export function stepPdfZoom(current: number, direction: 'in' | 'out'): number {
  const minChange = 1.05
  if (direction === 'in') {
    const next = PDF_ZOOM_STEPS.find((step) => step > current * minChange)
    return next ?? PDF_MAX_ZOOM
  }
  const lower = PDF_ZOOM_STEPS.filter((step) => step < current / minChange)
  return lower[lower.length - 1] ?? PDF_MIN_ZOOM
}

/**
 * Zoom at which a page of `pageWidthPt` points exactly fills `containerWidth` CSS pixels
 * (minus `padding` on each side). Rounded to whole percent so resizing does not re-render
 * pages for sub-percent changes.
 */
export function fitWidthZoom(containerWidth: number, pageWidthPt: number, padding = 0): number {
  if (!(containerWidth > 0) || !(pageWidthPt > 0)) return 1
  const available = Math.max(1, containerWidth - padding * 2)
  const zoom = available / (pageWidthPt * PDF_CSS_UNITS)
  return clampPdfZoom(Math.round(zoom * 100) / 100)
}

/** Whole-percent label for a zoom level, e.g. 1.25 -> "125 %". */
export function formatZoomPercent(zoom: number): string {
  return `${Math.round(zoom * 100)} %`
}

/** Keeps a page number within 1..count (1 if the document has no pages). */
export function clampPage(page: number, count: number): number {
  if (!Number.isFinite(page) || count < 1) return 1
  return Math.min(count, Math.max(1, Math.round(page)))
}

/** Vertical offset of every page in a column with `gap` between pages and around it. */
export function pageTops(heights: readonly number[], gap = PDF_PAGE_GAP): number[] {
  const tops: number[] = []
  let y = gap
  for (const height of heights) {
    tops.push(y)
    y += height + gap
  }
  return tops
}

/** Total height of a page column laid out like `pageTops`. */
export function columnHeight(heights: readonly number[], gap = PDF_PAGE_GAP): number {
  return heights.reduce((sum, h) => sum + h + gap, gap)
}

/**
 * Page (1-based) that occupies most of the viewport `[scrollTop, scrollTop + viewportHeight)`.
 * Ties go to the earlier page; a viewport between pages picks the nearest one.
 */
export function currentPageAt(
  tops: readonly number[],
  heights: readonly number[],
  scrollTop: number,
  viewportHeight: number,
): number {
  if (tops.length === 0) return 1
  const bottom = scrollTop + Math.max(0, viewportHeight)
  let best = 1
  let bestVisible = -Infinity
  for (let i = 0; i < tops.length; i++) {
    const top = tops[i] ?? 0
    const height = heights[i] ?? 0
    if (top > bottom) break
    const visible = Math.min(bottom, top + height) - Math.max(scrollTop, top)
    if (visible > bestVisible) {
      bestVisible = visible
      best = i + 1
    }
  }
  return best
}

/**
 * Canvas render scale for a page: zoom in CSS pixels times the device pixel ratio, reduced if the
 * canvas would exceed `maxPixels`.
 */
export function canvasRenderScale(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxPixels = PDF_MAX_CANVAS_PIXELS,
): number {
  const dpr = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1
  const area = cssWidth * cssHeight
  if (!(area > 0)) return dpr
  return Math.min(dpr, Math.sqrt(maxPixels / area))
}

/**
 * Horizontal offset of a page: centered in the viewport if it fits, otherwise `gap` from the left
 * edge (the content then scrolls horizontally).
 */
export function pageLeft(viewportWidth: number, pageWidth: number, gap = PDF_PAGE_GAP): number {
  return Math.max(gap, (viewportWidth - pageWidth) / 2)
}
