import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ObjectId } from 'mongodb'
import { CREDITS_PER_USD, remainingUsd } from './budgets.js'
import type { Config } from './config.js'
import type { Database } from './db.js'
import { safeEqual, sign } from './security.js'

export type MediaKind = 'image' | 'speech' | 'video' | 'cad'

export interface MediaFile {
  _id: string
  userId: string
  kind: MediaKind
  model: string
  mime: string
  extension: string
  size: number
  costUsd: number
  prompt: string
  createdAt: Date
  expiresAt: Date
}

export interface VideoJob {
  _id: string
  userId: string
  librechatUserId: ObjectId
  openrouterId: string
  model: string
  prompt: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  error: string | null
  fileId: string | null
  costUsd: number | null
  createdAt: Date
  updatedAt: Date
}

export class MediaError extends Error {}

export function mediaFiles(db: Database) {
  return db.portal.collection<MediaFile>('mediaFiles')
}

export function videoJobs(db: Database) {
  return db.portal.collection<VideoJob>('videoJobs')
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'audio/mpeg': 'mp3',
  'audio/pcm': 'pcm',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'model/stl': 'stl',
  'model/step': 'step',
  'model/3mf': '3mf',
  'model/gltf-binary': 'glb',
}

export async function storeMedia(
  config: Config,
  db: Database,
  input: { userId: string; kind: MediaKind; model: string; mime: string; data: Buffer; costUsd: number; prompt: string },
): Promise<MediaFile> {
  const extension = EXTENSIONS[input.mime] ?? 'bin'
  const file: MediaFile = {
    _id: randomUUID(),
    userId: input.userId,
    kind: input.kind,
    model: input.model,
    mime: input.mime,
    extension,
    size: input.data.length,
    costUsd: input.costUsd,
    prompt: input.prompt.slice(0, 500),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + config.MEDIA_RETENTION_DAYS * 86_400_000),
  }
  await mkdir(config.MEDIA_DIR, { recursive: true })
  await writeFile(join(config.MEDIA_DIR, `${file._id}.${extension}`), input.data)
  await mediaFiles(db).insertOne(file)
  return file
}

export async function readMedia(config: Config, file: MediaFile): Promise<Buffer> {
  return readFile(join(config.MEDIA_DIR, `${file._id}.${file.extension}`))
}

export async function pruneMedia(config: Config, db: Database, now = new Date()): Promise<number> {
  const expired = await mediaFiles(db).find({ expiresAt: { $lte: now } }).toArray()
  for (const file of expired) {
    await rm(join(config.MEDIA_DIR, `${file._id}.${file.extension}`), { force: true })
    await mediaFiles(db).deleteOne({ _id: file._id })
  }
  return expired.length
}

/** Download links work without login until they expire (they are shown in the person's chat). */
export function signedMediaUrl(config: Config, file: MediaFile, validDays = 7): string {
  const expires = Math.min(file.expiresAt.getTime(), Date.now() + validDays * 86_400_000)
  const signature = sign(config.PORTAL_SECRET, `media:${file._id}:${expires}`)
  return `${config.PUBLIC_URL}${config.basePath}/files/${file._id}.${file.extension}?exp=${expires}&sig=${signature}`
}

export function verifyMediaSignature(config: Config, fileId: string, expires: string, signature: string): boolean {
  const exp = Number(expires)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  return safeEqual(signature, sign(config.PORTAL_SECRET, `media:${fileId}:${exp}`))
}

/** Refuses a media request when the remaining budget is below the expected cost. */
export async function ensureBudget(db: Database, librechatUserId: ObjectId, minimumUsd: number): Promise<void> {
  const remaining = await remainingUsd(db, librechatUserId)
  if (remaining < minimumUsd) {
    throw new MediaError(
      `Nicht genug Guthaben: verbleibend ${remaining.toFixed(2)} USD, für diese Anfrage werden bis zu ${minimumUsd.toFixed(2)} USD benötigt. Bitte den Admin, das Limit zu erweitern.`,
    )
  }
}

/** Books a media charge as a negative credits transaction, like LibreChat's own usage. */
export async function chargeMedia(
  db: Database,
  librechatUserId: ObjectId,
  input: { kind: MediaKind; model: string; costUsd: number; conversationId: string | null },
): Promise<void> {
  const value = Math.round(input.costUsd * CREDITS_PER_USD)
  if (value <= 0) return
  const now = new Date()
  await db.librechat.collection('transactions').insertOne({
    user: librechatUserId,
    conversationId: input.conversationId ?? undefined,
    tokenType: 'credits',
    context: 'media',
    model: input.model,
    mediaKind: input.kind,
    rawAmount: -value,
    tokenValue: -value,
    rate: 1,
    createdAt: now,
    updatedAt: now,
  })
  await db.librechat.collection('balances').updateOne({ user: librechatUserId }, { $inc: { tokenCredits: -value } }, { upsert: true })
}
