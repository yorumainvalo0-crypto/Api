import { ObjectId } from 'mongodb'
import { CREDITS_PER_USD } from './budgets.js'
import type { Config } from './config.js'
import type { Database } from './db.js'

/** Model name under which searches appear in transactions and the usage dashboard */
export const WEB_SEARCH_MODEL = 'web_search'
const CHECKPOINT_ID = 'webSearchBilling'
/** Answers can be saved a while after they were created; re-scan this far back (billing is idempotent) */
const OVERLAP_MS = 30 * 60_000

interface SearchBilling {
  /** LibreChat messageId of the answer */
  _id: string
  searches: number
  updatedAt: Date
}

interface StoredMessage {
  messageId: string
  user: string
  conversationId?: string
  createdAt: Date
  content?: { type?: string; tool_call?: { id?: string; name?: string } }[]
}

/** Anthropic's server-side searches in one answer (server tool ids start with srvtoolu_). */
export function countWebSearches(message: Pick<StoredMessage, 'content'>): number {
  return (message.content ?? []).filter(
    (part) => part.type === 'tool_call' && part.tool_call?.name === 'web_search' && String(part.tool_call.id ?? '').startsWith('srvtoolu_'),
  ).length
}

/**
 * LibreChat bills only tokens; Anthropic charges each web search on top. This job finds the
 * searches in new answers and books them like media charges (one transaction per answer).
 */
export async function billWebSearches(config: Config, db: Database, now = new Date()): Promise<number> {
  const settings = db.portal.collection<{ _id: string; scannedUntil: Date }>('settings')
  const checkpoint = await settings.findOne({ _id: CHECKPOINT_ID })
  const since = new Date((checkpoint?.scannedUntil ?? new Date(0)).getTime() - OVERLAP_MS)
  const messages = db.librechat
    .collection<StoredMessage>('messages')
    .find({ createdAt: { $gte: since }, isCreatedByUser: false, 'content.tool_call.name': 'web_search' })
  const billings = db.portal.collection<SearchBilling>('webSearchBillings')
  let booked = 0
  for await (const message of messages) {
    const searches = countWebSearches(message)
    if (searches === 0 || !ObjectId.isValid(message.user)) continue
    // Atomic: parallel runs see the previous count, so every search is billed exactly once
    const previous = await billings.findOneAndUpdate(
      { _id: message.messageId },
      { $max: { searches }, $set: { updatedAt: now } },
      { upsert: true, returnDocument: 'before' },
    )
    const added = searches - (previous?.searches ?? 0)
    if (added <= 0) continue
    const credits = Math.round(added * config.WEB_SEARCH_USD * CREDITS_PER_USD)
    const user = new ObjectId(message.user)
    await db.librechat.collection('transactions').insertOne({
      user,
      conversationId: message.conversationId,
      messageId: message.messageId,
      tokenType: 'credits',
      context: 'media',
      model: WEB_SEARCH_MODEL,
      mediaKind: 'search',
      mediaStatus: 'charged',
      searches: added,
      rawAmount: -credits,
      tokenValue: -credits,
      rate: 1,
      createdAt: message.createdAt,
      updatedAt: now,
    })
    await db.librechat.collection('balances').updateOne({ user }, { $inc: { tokenCredits: -credits } })
    booked += added
  }
  await settings.updateOne({ _id: CHECKPOINT_ID }, { $set: { scannedUntil: now } }, { upsert: true })
  return booked
}
