import type { FastifyInstance } from 'fastify'
import { mediaFiles, readMedia, verifyMediaSignature } from '../media.js'
import { type AppContext, currentSession } from '../web.js'

export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, db } = ctx

  // Signed links from the chat; the owner's own device session works too
  app.get<{ Params: { name: string }; Querystring: { exp?: string; sig?: string } }>(
    `${config.basePath}/files/:name`,
    async (req, reply) => {
      const id = req.params.name.replace(/\.[a-z0-9]+$/, '')
      const file = await mediaFiles(db).findOne({ _id: id })
      if (!file) return reply.code(404).send('Datei nicht gefunden oder abgelaufen.')
      const signed = verifyMediaSignature(config, id, req.query.exp ?? '', req.query.sig ?? '')
      const session = signed ? null : await currentSession(ctx, req)
      if (!signed && session?.user._id !== file.userId) return reply.code(403).send('Link ungültig oder abgelaufen.')
      const data = await readMedia(config, file)
      return reply
        .header('content-type', file.mime)
        .header('content-length', data.length)
        .header('content-disposition', `inline; filename="${file.kind}-${file._id.slice(0, 8)}.${file.extension}"`)
        .header('cache-control', 'private, max-age=86400')
        .header('x-content-type-options', 'nosniff')
        .send(data)
    },
  )
}
