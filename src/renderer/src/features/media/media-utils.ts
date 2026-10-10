/*
 * Pure helpers for the media viewers (no DOM, no three.js) so they can be unit-tested in Node.
 */

/** Which three.js loader handles a 3D file. */
export type ModelLoaderKind = 'gltf' | 'obj' | 'stl' | 'ply'

/** Coarse preview category, derived from kind/mime type/extension. */
export type PreviewKind = 'image' | 'model3d' | 'pdf' | 'text' | 'file'

const MODEL_LOADERS: Record<string, ModelLoaderKind> = {
  glb: 'gltf',
  gltf: 'gltf',
  obj: 'obj',
  stl: 'stl',
  ply: 'ply',
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'])

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'jsonc',
  'csv',
  'tsv',
  'log',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'sh',
  'ps1',
  'bat',
  'cmd',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'sql',
  'scad',
])

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  pdf: 'application/pdf',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'model/obj',
  stl: 'model/stl',
  ply: 'application/ply',
  json: 'application/json',
  md: 'text/markdown',
  html: 'text/html',
  csv: 'text/csv',
}

/** Lower-case extension without the dot ('' if none). */
export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** Loader for a 3D file name, or null if the viewer cannot display it. */
export function modelLoaderKind(name: string): ModelLoaderKind | null {
  return MODEL_LOADERS[fileExtension(name)] ?? null
}

export function isImageName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(name))
}

export function isModelName(name: string): boolean {
  return modelLoaderKind(name) !== null
}

/** Best-effort MIME type from the file name (application/octet-stream if unknown). */
export function guessMimeType(name: string): string {
  const ext = fileExtension(name)
  return MIME_TYPES[ext] ?? (TEXT_EXTENSIONS.has(ext) ? 'text/plain' : 'application/octet-stream')
}

/** Picks the viewer for a file. `kind` is the attachment kind reported by the main process. */
export function previewKind(file: { name: string; kind: string; mimeType: string }): PreviewKind {
  const ext = fileExtension(file.name)
  if (file.kind === 'image' || file.mimeType === 'image/svg+xml' || IMAGE_EXTENSIONS.has(ext)) {
    return 'image'
  }
  if (file.kind === 'model3d' || MODEL_LOADERS[ext]) return 'model3d'
  if (file.kind === 'pdf' || file.mimeType === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (file.kind === 'text' || file.mimeType.startsWith('text/') || TEXT_EXTENSIONS.has(ext)) {
    return 'text'
  }
  return 'file'
}

/** Preview category for project files that get a media viewer instead of the text viewer. */
export function mediaPreviewForName(name: string): 'image' | 'model3d' | null {
  if (isModelName(name)) return 'model3d'
  if (isImageName(name)) return 'image'
  return null
}

/** Joins an absolute directory and a '/'-separated relative path using the directory's style. */
export function joinPath(dir: string, relPath: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  const base = dir.endsWith('\\') || dir.endsWith('/') ? dir.slice(0, -1) : dir
  const rel = relPath.replace(/^[\\/]+/, '').replace(/[\\/]/g, sep)
  return rel ? `${base}${sep}${rel}` : base
}

/** Directory part of an absolute path, including the trailing separator. */
export function dirWithSeparator(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut < 0 ? '' : path.slice(0, cut + 1)
}

/** Relative `mtllib` reference of an OBJ file, if any. */
export function objMaterialLibrary(objText: string): string | null {
  const match = /^[ \t]*mtllib[ \t]+(.+?)[ \t]*$/m.exec(objText)
  return match?.[1] ?? null
}

/**
 * Decodes a `data:` URI (base64 or percent-encoded) into bytes. glTF files often embed their
 * buffers this way, and the CSP does not allow fetch()ing data: URIs.
 */
export function decodeDataUri(uri: string): Uint8Array<ArrayBuffer> {
  const comma = uri.indexOf(',')
  if (!uri.startsWith('data:') || comma < 0) throw new Error('Ungültige data:-URI')
  const meta = uri.slice(5, comma)
  const payload = uri.slice(comma + 1)
  if (/;base64$/i.test(meta)) {
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  return new TextEncoder().encode(decodeURIComponent(payload))
}

/** True if a PLY header declares faces (otherwise the file is a point cloud). */
export function plyHasFaces(header: string): boolean {
  const end = header.indexOf('end_header')
  const head = end < 0 ? header : header.slice(0, end)
  const match = /^element[ \t]+face[ \t]+(\d+)/m.exec(head)
  return match ? Number(match[1]) > 0 : false
}

/** Center and bounding-sphere radius of an axis-aligned box. */
export function boxCenterAndRadius(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): { center: [number, number, number]; radius: number; size: [number, number, number] } {
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ]
  const radius = Math.hypot(size[0], size[1], size[2]) / 2
  return { center, size, radius }
}

/**
 * Camera distance at which a bounding sphere fits into a perspective view. Uses the narrower of
 * the vertical and horizontal field of view; `margin` > 1 leaves some space around the model.
 */
export function fitCameraDistance(
  radius: number,
  verticalFovDeg: number,
  aspect: number,
  margin = 1.15,
): number {
  const r = radius > 0 && Number.isFinite(radius) ? radius : 1
  const vFov = (verticalFovDeg * Math.PI) / 180
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (aspect > 0 ? aspect : 1))
  const fov = Math.min(vFov, hFov)
  return (r * margin) / Math.sin(fov / 2)
}

/** A round grid size (1, 2 or 5 × 10^n) that comfortably covers a model of `extent`. */
export function niceGridSize(extent: number): number {
  const target = (extent > 0 && Number.isFinite(extent) ? extent : 1) * 3
  const exponent = Math.floor(Math.log10(target))
  const unit = 10 ** exponent
  for (const step of [1, 2, 5, 10]) {
    if (step * unit >= target) return step * unit
  }
  return 10 * unit
}

/** Triangle count of a mesh geometry (indexed or not). */
export function triangleCount(positionCount: number, indexCount: number | null): number {
  return Math.floor((indexCount ?? positionCount) / 3)
}

/** German number formatting with thousands separators. */
export function formatCount(n: number): string {
  return new Intl.NumberFormat('de-DE').format(n)
}

export interface ZoomState {
  scale: number
  x: number
  y: number
}

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 20

/**
 * Zooms by `factor` keeping the point (`px`, `py`) – relative to the container center – fixed.
 * The content is transformed with `translate(x, y) scale(scale)` around the container center.
 */
export function zoomAt(state: ZoomState, factor: number, px = 0, py = 0): ZoomState {
  const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.scale * factor))
  const k = scale / state.scale
  return { scale, x: px - (px - state.x) * k, y: py - (py - state.y) * k }
}
