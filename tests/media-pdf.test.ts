import { describe, expect, it } from 'vitest'
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
  PDF_MAX_ZOOM,
  PDF_MIN_ZOOM,
  stepPdfZoom,
} from '../src/renderer/src/features/media/pdf-utils'

describe('clampPdfZoom', () => {
  it('limits the zoom range and tolerates garbage', () => {
    expect(clampPdfZoom(0.01)).toBe(PDF_MIN_ZOOM)
    expect(clampPdfZoom(99)).toBe(PDF_MAX_ZOOM)
    expect(clampPdfZoom(1.5)).toBe(1.5)
    expect(clampPdfZoom(Number.NaN)).toBe(1)
  })
})

describe('stepPdfZoom', () => {
  it('steps to the next level in both directions', () => {
    expect(stepPdfZoom(1, 'in')).toBe(1.1)
    expect(stepPdfZoom(1, 'out')).toBe(0.9)
  })

  it('steps from in-between values (e.g. after fit-width)', () => {
    expect(stepPdfZoom(1.18, 'in')).toBe(1.25)
    expect(stepPdfZoom(1.18, 'out')).toBe(1.1)
  })

  it('skips levels that would barely change the zoom', () => {
    expect(stepPdfZoom(1.09, 'in')).toBe(1.25)
    expect(stepPdfZoom(1.12, 'out')).toBe(1)
  })

  it('stops at the limits', () => {
    expect(stepPdfZoom(PDF_MAX_ZOOM, 'in')).toBe(PDF_MAX_ZOOM)
    expect(stepPdfZoom(PDF_MIN_ZOOM, 'out')).toBe(PDF_MIN_ZOOM)
  })
})

describe('fitWidthZoom', () => {
  it('fills the available width', () => {
    // A4 is 595 pt wide = 793.3 px at 100 %.
    const zoom = fitWidthZoom(800, 595)
    expect(zoom).toBeCloseTo(800 / (595 * PDF_CSS_UNITS), 2)
  })

  it('accounts for padding on both sides', () => {
    expect(fitWidthZoom(1000, 600, 100)).toBeCloseTo(800 / (600 * PDF_CSS_UNITS), 2)
  })

  it('falls back to 100 % for unknown sizes and clamps extremes', () => {
    expect(fitWidthZoom(0, 600)).toBe(1)
    expect(fitWidthZoom(800, 0)).toBe(1)
    expect(fitWidthZoom(50000, 100)).toBe(PDF_MAX_ZOOM)
    expect(fitWidthZoom(10, 5000)).toBe(PDF_MIN_ZOOM)
  })
})

describe('formatZoomPercent', () => {
  it('rounds to whole percent', () => {
    expect(formatZoomPercent(1.25)).toBe('125 %')
    expect(formatZoomPercent(0.333)).toBe('33 %')
  })
})

describe('clampPage', () => {
  it('keeps the page inside the document', () => {
    expect(clampPage(0, 10)).toBe(1)
    expect(clampPage(11, 10)).toBe(10)
    expect(clampPage(4.6, 10)).toBe(5)
    expect(clampPage(3, 0)).toBe(1)
    expect(clampPage(Number.NaN, 10)).toBe(1)
  })
})

describe('page layout', () => {
  const heights = [100, 200, 100]

  it('places pages below each other with a gap', () => {
    expect(pageTops(heights, 10)).toEqual([10, 120, 330])
    expect(columnHeight(heights, 10)).toBe(440)
    expect(columnHeight([], 10)).toBe(10)
  })

  it('finds the page that fills most of the viewport', () => {
    const tops = pageTops(heights, 10)
    expect(currentPageAt(tops, heights, 0, 100)).toBe(1)
    // Viewport 100..300 shows 20 px of page 1 and 180 px of page 2.
    expect(currentPageAt(tops, heights, 100, 200)).toBe(2)
    expect(currentPageAt(tops, heights, 330, 100)).toBe(3)
  })

  it('prefers the earlier page on a tie and handles the end of the document', () => {
    const tops = pageTops([100, 100], 0)
    expect(currentPageAt(tops, [100, 100], 50, 100)).toBe(1)
    expect(currentPageAt(tops, [100, 100], 5000, 100)).toBe(2)
    expect(currentPageAt([], [], 0, 100)).toBe(1)
  })
})

describe('canvasRenderScale', () => {
  it('uses the device pixel ratio for normal pages', () => {
    expect(canvasRenderScale(800, 1100, 2)).toBe(2)
    expect(canvasRenderScale(800, 1100, 1.25)).toBe(1.25)
  })

  it('reduces the ratio so huge canvases stay below the pixel budget', () => {
    const scale = canvasRenderScale(4000, 6000, 2, 16_000_000)
    expect(scale).toBeLessThan(2)
    expect(4000 * scale * 6000 * scale).toBeLessThanOrEqual(16_000_000 + 1)
  })

  it('falls back to 1 for invalid ratios', () => {
    expect(canvasRenderScale(100, 100, 0)).toBe(1)
    expect(canvasRenderScale(0, 0, 2)).toBe(2)
  })
})

describe('pageLeft', () => {
  it('centers pages that fit in the viewport', () => {
    expect(pageLeft(1000, 600, 12)).toBe(200)
  })

  it('pins wider pages to the left edge', () => {
    expect(pageLeft(1000, 1200, 12)).toBe(12)
    expect(pageLeft(1000, 980, 12)).toBe(12)
  })
})
