import { loadConfig } from './config.js'
import { connectDatabase } from './db.js'
import { buildApp } from './server.js'
import { bootstrapAdmin } from './users.js'

const config = loadConfig()
const db = await connectDatabase(config)
const admin = await bootstrapAdmin(db, config.PORTAL_ADMIN_USERNAME, config.PORTAL_ADMIN_PASSWORD)
const app = await buildApp({ config, db, logger: true })
if (admin) app.log.info(`created first admin "${admin.username}"`)

const shutdown = async () => {
  await app.close()
  await db.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

await app.listen({ host: '0.0.0.0', port: config.PORT })
