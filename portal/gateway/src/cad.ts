import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Config } from './config.js'
import type { Database } from './db.js'
import { MediaError, type MediaFile, mediaFiles, storeMedia } from './media.js'
import { safeEqual, sign } from './security.js'

export interface CadInfo {
  size_mm: [number, number, number]
  min_mm: [number, number, number]
  volume_mm3: number
  area_mm2: number
  watertight: boolean
  triangles: number
  solids: number
}

const finite = z.number().finite()
const vector = z.tuple([finite, finite, finite])

/** info.json is written inside the sandbox, so user code controls it: accept plain numbers only. */
export const cadInfoSchema = z
  .object({
    size_mm: vector,
    min_mm: vector,
    volume_mm3: finite,
    area_mm2: finite,
    watertight: z.boolean(),
    triangles: z.number().int().nonnegative(),
    solids: z.number().int().nonnegative(),
  })
  .strip()

export interface CadModel {
  _id: string
  userId: string
  conversationId: string | null
  name: string
  latestVersion: number
  createdAt: Date
  updatedAt: Date
}

/** Media file ids of one version's exports */
export interface CadFiles {
  stl: string
  glb: string
  png: string
  step?: string
  threemf?: string
}

export interface CadVersion {
  _id: string
  modelId: string
  version: number
  code: string
  info: CadInfo
  files: CadFiles
  createdAt: Date
}

export function cadModels(db: Database) {
  return db.portal.collection<CadModel>('cadModels')
}

export function cadVersions(db: Database) {
  return db.portal.collection<CadVersion>('cadVersions')
}

const OUTPUTS: Record<string, { key: keyof CadFiles; mime: string }> = {
  'model.stl': { key: 'stl', mime: 'model/stl' },
  'model.glb': { key: 'glb', mime: 'model/gltf-binary' },
  'preview.png': { key: 'png', mime: 'image/png' },
  'model.step': { key: 'step', mime: 'model/step' },
  'model.3mf': { key: 'threemf', mime: 'model/3mf' },
}

interface RunnerResponse {
  ok: boolean
  stdout: string
  stderr: string
  info: CadInfo | null
  files: Record<string, string>
}

/** Runs build123d code in the code runner's CAD sandbox. */
export async function runCad(config: Config, code: string, formats: string[]): Promise<RunnerResponse> {
  const res = await fetch(`${config.CODE_RUNNER_URL.replace(/\/+$/, '')}/v1/cad`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, formats }),
    signal: AbortSignal.timeout(150_000),
  })
  if (!res.ok) throw new MediaError(`CAD-Dienst nicht erreichbar (HTTP ${res.status}).`)
  const result = (await res.json()) as RunnerResponse
  if (result.ok) {
    const info = cadInfoSchema.safeParse(result.info)
    if (!info.success) return { ...result, ok: false, info: null, files: {}, stderr: 'CAD-Export lieferte ungültige Modelldaten.' }
    result.info = info.data as CadInfo
  }
  return result
}

/** Stores a successful CAD run as the next version of the model with this name in this chat. */
export async function saveCadVersion(
  config: Config,
  db: Database,
  input: { userId: string; conversationId: string | null; name: string; code: string; result: RunnerResponse },
): Promise<{ model: CadModel; version: CadVersion; files: Record<keyof CadFiles, MediaFile | undefined> }> {
  const name = input.name.trim().slice(0, 80) || 'Modell'
  const now = new Date()
  const model = await cadModels(db).findOneAndUpdate(
    { userId: input.userId, conversationId: input.conversationId, name },
    {
      $inc: { latestVersion: 1 },
      $set: { updatedAt: now },
      $setOnInsert: { _id: randomUUID(), userId: input.userId, conversationId: input.conversationId, name, createdAt: now },
    },
    { upsert: true, returnDocument: 'after' },
  )
  const stored: Partial<Record<keyof CadFiles, MediaFile>> = {}
  for (const [filename, data] of Object.entries(input.result.files)) {
    const output = OUTPUTS[filename]
    if (!output) continue
    stored[output.key] = await storeMedia(config, db, {
      userId: input.userId,
      kind: 'cad',
      model: 'build123d',
      mime: output.mime,
      data: Buffer.from(data, 'base64'),
      costUsd: 0,
      prompt: `${name} v${model!.latestVersion}`,
    })
  }
  if (!stored.stl || !stored.glb || !stored.png) throw new MediaError('CAD-Export unvollständig.')
  const version: CadVersion = {
    _id: randomUUID(),
    modelId: model!._id,
    version: model!.latestVersion,
    code: input.code,
    info: input.result.info!,
    files: {
      stl: stored.stl._id,
      glb: stored.glb._id,
      png: stored.png._id,
      ...(stored.step ? { step: stored.step._id } : {}),
      ...(stored.threemf ? { threemf: stored.threemf._id } : {}),
    },
    createdAt: now,
  }
  await cadVersions(db).insertOne(version)
  return { model: model!, version, files: stored as Record<keyof CadFiles, MediaFile | undefined> }
}

export async function versionFiles(db: Database, version: CadVersion): Promise<Partial<Record<keyof CadFiles, MediaFile>>> {
  const ids = Object.values(version.files)
  const files = await mediaFiles(db).find({ _id: { $in: ids } }).toArray()
  const byId = new Map(files.map((f) => [f._id, f]))
  const result: Partial<Record<keyof CadFiles, MediaFile>> = {}
  for (const [key, id] of Object.entries(version.files) as [keyof CadFiles, string][]) {
    const file = byId.get(id)
    if (file) result[key] = file
  }
  return result
}

/** Viewer links are signed like media links and cover all versions of a model. */
export function signedViewerUrl(config: Config, modelId: string, version: number, validDays = 30): string {
  const expires = Date.now() + validDays * 86_400_000
  const signature = sign(config.PORTAL_SECRET, `viewer:${modelId}:${expires}`)
  return `${config.PUBLIC_URL}${config.basePath}/view/${modelId}?v=${version}&exp=${expires}&sig=${signature}`
}

export function verifyViewerSignature(config: Config, modelId: string, expires: string, signature: string): boolean {
  const exp = Number(expires)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  return safeEqual(signature, sign(config.PORTAL_SECRET, `viewer:${modelId}:${exp}`))
}

export function formatMm(value: number): string {
  return Number(value).toLocaleString('de-DE', { maximumFractionDigits: 2 })
}

export function describeInfo(info: CadInfo): string {
  const [x, y, z] = info.size_mm
  const volumeCm3 = info.volume_mm3 / 1000
  return [
    `Maße: ${formatMm(x)} × ${formatMm(y)} × ${formatMm(z)} mm (B × T × H)`,
    `Volumen: ${volumeCm3.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} cm³`,
    `Oberfläche: ${(info.area_mm2 / 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} cm²`,
    `Wasserdicht (druckbar): ${info.watertight ? 'ja' : 'NEIN – Netz hat Löcher'}`,
    `Körper: ${info.solids}`,
  ].join('\n')
}
