import { startBudgetJobs } from './budgets.js'
import { loadConfig } from './config.js'
import { pruneMedia } from './media.js'
import { billWebSearches } from './search.js'
import { pollVideoJobs } from './tools/media.js'
import { connectDatabase } from './db.js'
import { buildApp } from './server.js'
import { bootstrapAdmin } from './users.js'

const config = loadConfig()
const db = await connectDatabase(config)
const admin = await bootstrapAdmin(db, config.PORTAL_ADMIN_USERNAME, config.PORTAL_ADMIN_PASSWORD)
const app = await buildApp({ config, db, logger: true })
if (admin) app.log.info(`created first admin "${admin.username}"`)
const stopJobs = startBudgetJobs(db, (error) => app.log.error({ err: error }, 'budget job failed'))
const mediaTimer = setInterval(() => {
  if (config.MEDIA_ENABLED) pollVideoJobs(config, db).catch((error) => app.log.error({ err: error }, 'video job failed'))
  billWebSearches(config, db).catch((error) => app.log.error({ err: error }, 'web search billing failed'))
}, 15_000)
const pruneTimer = setInterval(() => {
  pruneMedia(config, db).catch((error) => app.log.error({ err: error }, 'media prune failed'))
}, 3_600_000)

const shutdown = async () => {
  stopJobs()
  clearInterval(mediaTimer)
  clearInterval(pruneTimer)
  await app.close()
  await db.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

await app.listen({ host: '0.0.0.0', port: config.PORT })
