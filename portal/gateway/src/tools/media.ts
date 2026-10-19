import { randomUUID } from 'node:crypto'
import type { ObjectId } from 'mongodb'
import { z } from 'zod'
import type { Config } from '../config.js'
import type { Database } from '../db.js'
import { defineTool, textResult } from '../mcp.js'
import {
  MediaError,
  type MediaFile,
  type MediaKind,
  mediaFiles,
  readMedia,
  reserveMedia,
  settleMedia,
  signedMediaUrl,
  storeMedia,
  videoJobs,
} from '../media.js'
import { OpenRouter } from '../openrouter.js'

/** Videos one person may have in progress at the same time */
const MAX_RUNNING_VIDEOS = 2

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] as const

function usd(value: number): string {
  return `${value.toFixed(value < 0.1 ? 4 : 2)} USD`
}

function failure(error: unknown) {
  if (error instanceof MediaError) return textResult(error.message, true)
  throw error
}

/** Reserves the expected cost, runs the provider call and books its real cost (nothing if it fails). */
async function billed<T>(
  db: Database,
  librechatUserId: ObjectId,
  input: { kind: MediaKind; model: string; costUsd: number; conversationId: string | null },
  call: () => Promise<T>,
  cost: (result: T) => number | Promise<number>,
): Promise<{ result: T; cost: number }> {
  const reservation = await reserveMedia(db, librechatUserId, input)
  let result: T
  try {
    result = await call()
  } catch (error) {
    await settleMedia(db, reservation, 0)
    throw error
  }
  const actual = await cost(result)
  await settleMedia(db, reservation, actual)
  return { result, cost: actual }
}

async function ownImage(db: Database, userId: string, id: string): Promise<MediaFile> {
  const file = await mediaFiles(db).findOne({ _id: id, userId, kind: 'image' })
  if (!file) throw new MediaError(`Bild „${id}“ nicht gefunden. Es können nur Bilder verwendet werden, die in diesem Portal erzeugt wurden.`)
  return file
}

export const createImageTool = defineTool({
  name: 'bild_erstellen',
  title: 'Bild erstellen',
  description:
    'Erzeugt ein Bild aus einer Beschreibung (über OpenRouter, wird vom Guthaben des Nutzers abgebucht). ' +
    'Schreibe einen ausführlichen, konkreten Prompt (Motiv, Stil, Licht, Perspektive). Das Ergebnis wird im Chat angezeigt; ' +
    'die Bild-ID kann mit bild_bearbeiten oder video_erstellen weiterverwendet werden.',
  inputSchema: {
    prompt: z.string().min(3).max(4000).describe('Detaillierte Bildbeschreibung'),
    seitenverhaeltnis: z.enum(ASPECT_RATIOS).optional().describe('Seitenverhältnis, Standard 1:1'),
  },
  async run(args, { db, config, user, librechatUserId, conversationId }) {
    try {
      const { result, cost } = await billed(
        db,
        librechatUserId,
        { kind: 'image', model: config.IMAGE_MODEL, costUsd: config.IMAGE_MIN_BALANCE_USD, conversationId },
        () => new OpenRouter(config).createImage({ model: config.IMAGE_MODEL, prompt: args.prompt, aspectRatio: args.seitenverhaeltnis }),
        (r) => r.costUsd ?? config.IMAGE_MIN_BALANCE_USD,
      )
      const file = await storeMedia(config, db, { userId: user._id, kind: 'image', model: config.IMAGE_MODEL, mime: result.mime, data: result.data, costUsd: cost, prompt: args.prompt })
      return {
        content: [
          { type: 'image', data: result.data.toString('base64'), mimeType: result.mime },
          {
            type: 'text',
            text: `Bild erstellt (Kosten ${usd(cost)}). Bild-ID: ${file._id}\nDownload in voller Auflösung: ${signedMediaUrl(config, file)}`,
          },
        ],
      }
    } catch (error) {
      return failure(error)
    }
  },
})

export const editImageTool = defineTool({
  name: 'bild_bearbeiten',
  title: 'Bild bearbeiten',
  description:
    'Verändert ein zuvor mit bild_erstellen erzeugtes Bild nach einer Anweisung (z. B. „als Aquarell“, „Hintergrund blau“). ' +
    'Braucht die Bild-ID aus dem früheren Ergebnis. Kosten werden vom Guthaben abgebucht.',
  inputSchema: {
    bild_id: z.string().describe('Bild-ID aus einem früheren Ergebnis'),
    anweisung: z.string().min(3).max(4000).describe('Was am Bild geändert werden soll'),
  },
  async run(args, { db, config, user, librechatUserId, conversationId }) {
    try {
      const source = await ownImage(db, user._id, args.bild_id)
      const dataUrl = `data:${source.mime};base64,${(await readMedia(config, source)).toString('base64')}`
      const { result, cost } = await billed(
        db,
        librechatUserId,
        { kind: 'image', model: config.IMAGE_MODEL, costUsd: config.IMAGE_MIN_BALANCE_USD, conversationId },
        () => new OpenRouter(config).createImage({ model: config.IMAGE_MODEL, prompt: args.anweisung, references: [dataUrl] }),
        (r) => r.costUsd ?? config.IMAGE_MIN_BALANCE_USD,
      )
      const file = await storeMedia(config, db, { userId: user._id, kind: 'image', model: config.IMAGE_MODEL, mime: result.mime, data: result.data, costUsd: cost, prompt: args.anweisung })
      return {
        content: [
          { type: 'image', data: result.data.toString('base64'), mimeType: result.mime },
          { type: 'text', text: `Bild bearbeitet (Kosten ${usd(cost)}). Neue Bild-ID: ${file._id}\nDownload: ${signedMediaUrl(config, file)}` },
        ],
      }
    } catch (error) {
      return failure(error)
    }
  },
})

export const createSpeechTool = defineTool({
  name: 'sprache_erstellen',
  title: 'Sprachausgabe erstellen',
  description:
    'Wandelt Text in gesprochene Sprache (MP3) um, z. B. zum Vorlesen oder für Ansagen. Liefert einen Download-Link. ' +
    'Kosten werden vom Guthaben abgebucht. Gib dem Nutzer den Link unverändert weiter.',
  inputSchema: {
    text: z.string().min(1).max(4000).describe('Der vorzulesende Text'),
    stimme: z.string().max(80).optional().describe('Stimme (Standard: vom Admin festgelegt)'),
    sprechweise: z.string().max(500).optional().describe('Optionale Anweisung zur Sprechweise, z. B. „ruhig und freundlich“'),
  },
  async run(args, { db, config, user, librechatUserId, conversationId }) {
    try {
      const router = new OpenRouter(config)
      let reported: number | null = null
      const { result, cost } = await billed(
        db,
        librechatUserId,
        { kind: 'speech', model: config.TTS_MODEL, costUsd: config.TTS_MIN_BALANCE_USD, conversationId },
        () => router.createSpeech({ model: config.TTS_MODEL, text: args.text, voice: args.stimme ?? config.TTS_VOICE, instructions: args.sprechweise }),
        async (r) => {
          reported = r.generationId ? await router.generationCost(r.generationId) : null
          return reported ?? (args.text.length / 1000) * config.TTS_USD_PER_1K_CHARS
        },
      )
      const file = await storeMedia(config, db, { userId: user._id, kind: 'speech', model: config.TTS_MODEL, mime: result.mime, data: result.data, costUsd: cost, prompt: args.text })
      return {
        content: [
          {
            type: 'text',
            text: `Sprachausgabe erstellt (${Math.round(result.data.length / 1024)} KB, Kosten ${usd(cost)}${reported === null ? ', geschätzt' : ''}).\nAnhören/Download: ${signedMediaUrl(config, file)}`,
          },
        ],
      }
    } catch (error) {
      return failure(error)
    }
  },
})

export const createVideoTool = defineTool({
  name: 'video_erstellen',
  title: 'Video erstellen',
  description:
    'Startet die Erzeugung eines kurzen Videos aus einer Beschreibung (optional aus einem zuvor erzeugten Bild als erstes Bild). ' +
    'Das dauert einige Minuten und ist teuer – nur verwenden, wenn der Nutzer ausdrücklich ein Video möchte. ' +
    'Liefert eine Video-ID; den Fortschritt mit video_status abfragen.',
  inputSchema: {
    prompt: z.string().min(3).max(4000).describe('Beschreibung der Szene und Bewegung'),
    dauer_sekunden: z.number().int().min(2).max(10).optional().describe('Länge in Sekunden (Standard: Modellstandard)'),
    seitenverhaeltnis: z.enum(['16:9', '9:16', '1:1']).optional(),
    start_bild_id: z.string().optional().describe('Bild-ID eines zuvor erzeugten Bildes als erstes Bild'),
  },
  async run(args, { db, config, user, librechatUserId }) {
    try {
      const running = await videoJobs(db).countDocuments({ userId: user._id, status: { $in: ['pending', 'in_progress'] } })
      if (running >= MAX_RUNNING_VIDEOS) {
        return textResult(`Es laufen schon ${running} Videos. Bitte warten, bis eines fertig ist.`, true)
      }
      let firstFrame: string | undefined
      if (args.start_bild_id) {
        const image = await ownImage(db, user._id, args.start_bild_id)
        firstFrame = `data:${image.mime};base64,${(await readMedia(config, image)).toString('base64')}`
      }
      // The cost is known only when the video is done: reserve now, settle in pollVideoJobs
      const reservation = await reserveMedia(db, librechatUserId, {
        kind: 'video',
        model: config.VIDEO_MODEL,
        costUsd: config.VIDEO_MIN_BALANCE_USD,
        conversationId: null,
      })
      let id: string
      try {
        ;({ id } = await new OpenRouter(config).submitVideo({
          model: config.VIDEO_MODEL,
          prompt: args.prompt,
          duration: args.dauer_sekunden,
          aspectRatio: args.seitenverhaeltnis,
          firstFrame,
        }))
      } catch (error) {
        await settleMedia(db, reservation, 0)
        throw error
      }
      const now = new Date()
      const job = {
        _id: randomUUID(),
        userId: user._id,
        librechatUserId,
        openrouterId: id,
        model: config.VIDEO_MODEL,
        prompt: args.prompt.slice(0, 500),
        status: 'pending' as const,
        error: null,
        fileId: null,
        costUsd: null,
        reservation,
        createdAt: now,
        updatedAt: now,
      }
      await videoJobs(db).insertOne(job)
      return textResult(
        `Video wird erstellt. Video-ID: ${job._id}\nDas dauert meist einige Minuten. Frage den Status mit video_status ab, wenn der Nutzer nachfragt.`,
      )
    } catch (error) {
      return failure(error)
    }
  },
})

export const videoStatusTool = defineTool({
  name: 'video_status',
  title: 'Video-Status',
  description: 'Zeigt, ob ein mit video_erstellen gestartetes Video fertig ist, und liefert dann den Download-Link.',
  inputSchema: { video_id: z.string().describe('Video-ID aus video_erstellen') },
  async run(args, { db, config, user }) {
    const job = await videoJobs(db).findOne({ _id: args.video_id, userId: user._id })
    if (!job) return textResult('Video nicht gefunden.', true)
    if (job.status === 'failed') return textResult(`Die Videoerzeugung ist fehlgeschlagen: ${job.error ?? 'unbekannter Fehler'}. Es wurde nichts abgebucht.`)
    if (job.status !== 'completed' || !job.fileId) {
      const minutes = Math.round((Date.now() - job.createdAt.getTime()) / 60_000)
      return textResult(`Das Video wird noch erstellt (seit ${minutes} Min.). Bitte später erneut nachfragen.`)
    }
    const file = await mediaFiles(db).findOne({ _id: job.fileId })
    if (!file) return textResult('Das Video ist nicht mehr gespeichert.', true)
    return textResult(`Das Video ist fertig (Kosten ${usd(job.costUsd ?? 0)}).\nAnsehen/Download: ${signedMediaUrl(config, file)}`)
  },
})

export const mediaTools = [createImageTool, editImageTool, createSpeechTool, createVideoTool, videoStatusTool]

/** Background job: checks running video jobs, stores finished videos and charges their cost. */
export async function pollVideoJobs(config: Config, db: Database): Promise<number> {
  const running = await videoJobs(db).find({ status: { $in: ['pending', 'in_progress'] } }).toArray()
  const router = new OpenRouter(config)
  let finished = 0
  for (const job of running) {
    const status = await router.videoStatus(job.openrouterId)
    if (status.status === 'failed') {
      const failed = await videoJobs(db).findOneAndUpdate(
        { _id: job._id, status: { $in: ['pending', 'in_progress'] } },
        { $set: { status: 'failed', error: status.error, updatedAt: new Date() } },
      )
      if (failed?.reservation) await settleMedia(db, failed.reservation, 0)
      continue
    }
    if (status.status !== 'completed') {
      if (status.status !== job.status) {
        await videoJobs(db).updateOne({ _id: job._id }, { $set: { status: 'in_progress', updatedAt: new Date() } })
      }
      continue
    }
    // Claim the job so a parallel run does not store and charge it twice
    const claimed = await videoJobs(db).findOneAndUpdate(
      { _id: job._id, status: { $in: ['pending', 'in_progress'] } },
      { $set: { status: 'completed', updatedAt: new Date() } },
    )
    if (!claimed) continue
    const content = await router.videoContent(job.openrouterId)
    const cost = status.costUsd ?? config.VIDEO_MIN_BALANCE_USD
    if (claimed.reservation) await settleMedia(db, claimed.reservation, cost)
    const file = await storeMedia(config, db, { userId: job.userId, kind: 'video', model: job.model, mime: content.mime, data: content.data, costUsd: cost, prompt: job.prompt })
    await videoJobs(db).updateOne({ _id: job._id }, { $set: { fileId: file._id, costUsd: cost, updatedAt: new Date() } })
    finished++
  }
  return finished
}
