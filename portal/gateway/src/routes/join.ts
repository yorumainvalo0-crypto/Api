import type { FastifyInstance } from 'fastify'
import { SESSION_COOKIE, createDeviceSession, deviceLabel } from '../devices.js'
import { html, page } from '../html.js'
import { findInvite, inviteState, joinWithInvite } from '../invites.js'
import { audit } from '../users.js'
import { type AppContext, cookieOptions, field, formatDate, sendHtml } from '../web.js'

const CLOSED: Record<string, string> = {
  invalid: 'Diese Einladung gibt es nicht.',
  'not-yet': 'Diese Einladung ist noch nicht gültig.',
  expired: 'Diese Einladung ist abgelaufen.',
  full: 'Alle Plätze dieser Einladung sind vergeben.',
  revoked: 'Diese Einladung wurde zurückgezogen.',
}

export function registerJoinRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, db } = ctx
  const base = config.basePath

  async function joinPage(token: string, username: string, error: string): Promise<{ status: number; body: string }> {
    const invite = await findInvite(db, token)
    const state = invite ? inviteState(invite) : 'invalid'
    if (!invite || state !== 'active') {
      const extra = state === 'not-yet' && invite ? ` Ab ${formatDate(invite.validFrom)} Uhr.` : ''
      return {
        status: 410,
        body: page('Einladung', html`<h1>Einladung</h1><div class="card"><p class="error">${CLOSED[state] ?? ""}${extra}</p></div>`, { narrow: true }),
      }
    }
    const group = await db.col.groups.findOne({ _id: invite.groupId })
    return {
      status: error ? 400 : 200,
      body: page(
        'Einladung',
        html`<h1>Willkommen im A-B Cloud AI Portal</h1>
          <form method="post" class="card">
            <p>Du wurdest in die Gruppe <strong>${group?.name ?? ''}</strong> eingeladen.
              Wähle einen Benutzernamen – damit kann dich der Admin später wiederfinden.</p>
            ${error ? html`<p class="error">${error}</p>` : ''}
            <label for="username">Benutzername</label>
            <input id="username" name="username" value="${username}" autocomplete="username" autocapitalize="none"
              minlength="3" maxlength="32" pattern="[A-Za-z0-9._-]{3,32}" required autofocus>
            <p class="muted">3–32 Zeichen: Buchstaben, Ziffern, Punkt, Unterstrich, Bindestrich.</p>
            <button type="submit">Beitreten</button>
            <p class="muted">Einladung gültig bis ${formatDate(invite.validUntil)} Uhr.
              Mit dem Beitritt stimmst du zu, dass deine Eingaben zur Verarbeitung an Anthropic übertragen werden.</p>
          </form>`,
        { narrow: true },
      ),
    }
  }

  app.get<{ Params: { token: string } }>(`${base}/join/:token`, async (req, reply) => {
    const { status, body } = await joinPage(req.params.token, '', '')
    return sendHtml(reply, body, status)
  })

  app.post<{ Params: { token: string } }>(
    `${base}/join/:token`,
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const username = field(req.body, 'username')
      const result = await joinWithInvite(db, req.params.token, username)
      if (!result.ok) {
        const message = result.reason === 'username' ? (result.message ?? '') : ''
        const { status, body } = await joinPage(req.params.token, username, message)
        return sendHtml(reply, body, result.reason === 'username' ? 400 : status)
      }
      const userAgent = req.headers['user-agent'] ?? ''
      const { token } = await createDeviceSession(db, result.user, {
        label: deviceLabel(userAgent),
        userAgent,
        days: config.DEVICE_SESSION_DAYS,
      })
      await audit(db, result.user.username, 'invite.joined', result.user._id, { inviteId: result.invite._id })
      reply.setCookie(SESSION_COOKIE, token, cookieOptions(config, config.DEVICE_SESSION_DAYS * 86_400))
      return reply.redirect(`${config.PUBLIC_URL}/`)
    },
  )
}
