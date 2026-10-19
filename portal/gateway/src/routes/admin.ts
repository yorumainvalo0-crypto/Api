import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { PortalUser } from '../db.js'
import { listDevices, revokeAllDevices, revokeDevice, type SessionContext } from '../devices.js'
import { html, page, type SafeHtml } from '../html.js'
import { createLoginLink, listLoginLinks, revokeLoginLink } from '../login-links.js'
import { UserError, audit, createUser } from '../users.js'
import {
  type AppContext,
  checkCsrf,
  csrfField,
  currentSession,
  field,
  formatDate,
  isAdminVerified,
  qrSvg,
  sendHtml,
} from '../web.js'

export type AdminSection = 'users' | 'groups' | 'usage' | 'audit'

export function adminNav(base: string, active: AdminSection, session: SessionContext, csrf: SafeHtml): SafeHtml {
  const link = (section: AdminSection, href: string, label: string) =>
    html`<a href="${href}" class="${active === section ? 'active' : ''}">${label}</a>`
  return html`<nav>
    ${link('users', `${base}/admin`, 'Benutzer')}
    ${link('groups', `${base}/admin/groups`, 'Gruppen & Einladungen')}
    ${link('usage', `${base}/admin/usage`, 'Verbrauch')}
    ${link('audit', `${base}/admin/audit`, 'Protokoll')}
    <span style="flex:1"></span>
    <span class="muted">${session.user.username}</span>
    <form method="post" action="${base}/logout" class="inline">${csrf}<button class="secondary">Abmelden</button></form>
  </nav>`
}

/** Runs an admin handler only for verified admins; POSTs additionally need a valid CSRF token. */
export function adminRoute<T extends FastifyRequest>(
  ctx: AppContext,
  handler: (req: T, reply: FastifyReply, session: SessionContext) => Promise<unknown>,
) {
  return async (req: T, reply: FastifyReply) => {
    const session = await currentSession(ctx, req)
    if (!isAdminVerified(session)) {
      return reply.redirect(`${ctx.config.basePath}/admin/login`)
    }
    if (req.method === 'POST' && !checkCsrf(ctx.config, session, req.body)) {
      return reply.code(403).send('CSRF-Prüfung fehlgeschlagen. Seite neu laden und erneut versuchen.')
    }
    return handler(req, reply, session)
  }
}

function statusLabel(user: PortalUser): SafeHtml {
  return user.status === 'active' ? html`<span class="ok">aktiv</span>` : html`<span class="error">gesperrt</span>`
}

/** Logs the user out of LibreChat everywhere (its refresh sessions live in the sessions collection). */
async function endLibrechatSessions(ctx: AppContext, userId: string): Promise<void> {
  const user = await ctx.db.col.users.findOne({ _id: userId })
  const librechatUser = user?.librechatUserId
    ? { _id: user.librechatUserId }
    : await ctx.db.librechat.collection('users').findOne({ openidId: userId }, { projection: { _id: 1 } })
  if (librechatUser) await ctx.db.librechat.collection('sessions').deleteMany({ user: librechatUser._id })
  await ctx.db.col.oidc.deleteMany({ model: 'Session', 'payload.accountId': userId })
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, db } = ctx
  const base = config.basePath

  app.get(
    `${base}/admin`,
    adminRoute(ctx, async (req, reply, session) => {
      const users = await db.col.users.find().sort({ createdAt: -1 }).toArray()
      const error = (req.query as { error?: string }).error ?? ''
      const csrf = csrfField(config, session)
      return sendHtml(
        reply,
        page(
          'Benutzer',
          html`<h1>Benutzer</h1>
            <form method="post" action="${base}/admin/users" class="card">
              ${csrf}
              <h2 style="margin-top:0">Benutzer direkt anlegen</h2>
              <p class="muted">Normalerweise treten Personen über einen Einladungs-QR bei. Hier legst du einzelne Accounts an
                und erzeugst danach einen Login-QR.</p>
              ${error ? html`<p class="error">${error}</p>` : ''}
              <div class="row">
                <div><label for="username">Benutzername</label><input id="username" name="username" required></div>
                <div><label for="startBudgetUsd">Startbudget (USD)</label><input id="startBudgetUsd" name="startBudgetUsd" type="number" min="0" step="0.01" value="5"></div>
                <div><label for="monthlyBudgetUsd">Monatsbudget (USD)</label><input id="monthlyBudgetUsd" name="monthlyBudgetUsd" type="number" min="0" step="0.01" value="5"></div>
              </div>
              <button type="submit">Anlegen</button>
            </form>
            <div class="card table-wrap">
              <table>
                <thead><tr><th>Benutzer</th><th>Rolle</th><th>Status</th><th>Monatsbudget</th><th>Angelegt</th></tr></thead>
                <tbody>
                  ${users.map(
                    (u) => html`<tr>
                      <td><a href="${base}/admin/users/${u._id}">${u.username}</a></td>
                      <td>${u.role === 'admin' ? 'Admin' : 'Nutzer'}</td>
                      <td>${statusLabel(u)}</td>
                      <td>${u.monthlyBudgetUsd.toFixed(2)} $</td>
                      <td>${formatDate(u.createdAt)}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>`,
          { nav: adminNav(base, 'users', session, csrf) },
        ),
      )
    }),
  )

  app.post(
    `${base}/admin/users`,
    adminRoute(ctx, async (req, reply, session) => {
      try {
        const user = await createUser(db, {
          username: field(req.body, 'username'),
          startBudgetUsd: Math.max(0, Number(field(req.body, 'startBudgetUsd')) || 0),
          monthlyBudgetUsd: Math.max(0, Number(field(req.body, 'monthlyBudgetUsd')) || 0),
        })
        await audit(db, session.user.username, 'user.created', user._id, { username: user.username })
        return reply.redirect(`${base}/admin/users/${user._id}`)
      } catch (error) {
        if (error instanceof UserError) {
          return reply.redirect(`${base}/admin?error=${encodeURIComponent(error.message)}`)
        }
        throw error
      }
    }),
  )

  app.get<{ Params: { id: string }; Querystring: { qr?: string } }>(
    `${base}/admin/users/:id`,
    adminRoute(ctx, async (req, reply, session) => {
      const user = await db.col.users.findOne({ _id: req.params.id })
      if (!user) return reply.code(404).send('Benutzer nicht gefunden')
      const [devices, links] = await Promise.all([listDevices(db, user._id), listLoginLinks(db, user._id)])
      const csrf = csrfField(config, session)
      // A freshly created login link is passed once via query (token is never stored)
      const newToken = req.query.qr
      const newLinkUrl = newToken ? `${config.PUBLIC_URL}${base}/l/${newToken}` : null
      return sendHtml(
        reply,
        page(
          user.username,
          html`<h1>${user.username} ${statusLabel(user)}</h1>
            ${
              newLinkUrl
                ? html`<div class="card">
                    <h2 style="margin-top:0">Login-QR-Code</h2>
                    <p>Mit dem Handy scannen oder Link weitergeben. Er wird nur jetzt angezeigt.</p>
                    <div class="qr">${await qrSvg(newLinkUrl)}</div>
                    <p><code id="login-link">${newLinkUrl}</code></p>
                  </div>`
                : ''
            }
            <form method="post" action="${base}/admin/users/${user._id}/login-links" class="card">
              ${csrf}
              <h2 style="margin-top:0">Neuen Login-QR erstellen</h2>
              <div class="row">
                <div><label for="validHours">Gültig für (Stunden)</label><input id="validHours" name="validHours" type="number" min="1" max="720" value="24"></div>
                <div><label for="maxUses">Wie oft nutzbar</label><input id="maxUses" name="maxUses" type="number" min="1" max="20" value="1"></div>
                <div><label for="note">Notiz (z. B. Tablet)</label><input id="note" name="note" maxlength="100"></div>
              </div>
              <button type="submit">QR-Code erstellen</button>
            </form>

            <h2>Login-Links</h2>
            <div class="card table-wrap"><table>
              <thead><tr><th>Erstellt</th><th>Notiz</th><th>Genutzt</th><th>Gültig bis</th><th></th></tr></thead>
              <tbody>${links.map(
                (l) => html`<tr>
                  <td>${formatDate(l.createdAt)}</td><td>${l.note || '–'}</td><td>${l.uses} / ${l.maxUses}</td>
                  <td>${l.revokedAt ? html`<span class="error">widerrufen</span>` : formatDate(l.expiresAt)}</td>
                  <td>${
                    l.revokedAt
                      ? ''
                      : html`<form method="post" action="${base}/admin/users/${user._id}/login-links/${l._id}/revoke" class="inline">${csrf}<button class="secondary">Widerrufen</button></form>`
                  }</td>
                </tr>`,
              )}</tbody>
            </table></div>

            <h2>Geräte</h2>
            <div class="card table-wrap"><table>
              <thead><tr><th>Gerät</th><th>Angemeldet</th><th>Zuletzt aktiv</th><th></th></tr></thead>
              <tbody>${devices.map(
                (d) => html`<tr>
                  <td>${d.label}</td><td>${formatDate(d.createdAt)}</td><td>${formatDate(d.lastSeenAt)}</td>
                  <td>${
                    d.revokedAt
                      ? html`<span class="muted">abgemeldet</span>`
                      : html`<form method="post" action="${base}/admin/users/${user._id}/devices/${d._id}/revoke" class="inline">${csrf}<button class="secondary">Abmelden</button></form>`
                  }</td>
                </tr>`,
              )}</tbody>
            </table></div>

            ${
              user._id === session.user._id
                ? ''
                : html`<form method="post" action="${base}/admin/users/${user._id}/${user.status === 'active' ? 'block' : 'unblock'}" class="card">
                    ${csrf}
                    <h2 style="margin-top:0">${user.status === 'active' ? 'Zugang sperren' : 'Zugang entsperren'}</h2>
                    <p class="muted">${
                      user.status === 'active'
                        ? 'Meldet alle Geräte ab und verhindert neue Anmeldungen.'
                        : 'Danach braucht die Person einen neuen Login-QR.'
                    }</p>
                    <button class="${user.status === 'active' ? 'danger' : ''}">${user.status === 'active' ? 'Sperren' : 'Entsperren'}</button>
                  </form>`
            }`,
          { nav: adminNav(base, 'users', session, csrf) },
        ),
      )
    }),
  )

  app.post<{ Params: { id: string } }>(
    `${base}/admin/users/:id/login-links`,
    adminRoute(ctx, async (req, reply, session) => {
      const user = await db.col.users.findOne({ _id: req.params.id, status: 'active' })
      if (!user) return reply.code(404).send('Benutzer nicht gefunden oder gesperrt')
      const validHours = Math.min(720, Math.max(1, Number(field(req.body, 'validHours')) || 24))
      const maxUses = Math.min(20, Math.max(1, Number(field(req.body, 'maxUses')) || 1))
      const { token, link } = await createLoginLink(db, {
        userId: user._id,
        createdBy: session.user._id,
        validHours,
        maxUses,
        note: field(req.body, 'note'),
      })
      await audit(db, session.user.username, 'login-link.created', user._id, { linkId: link._id, validHours, maxUses })
      return reply.redirect(`${base}/admin/users/${user._id}?qr=${token}`)
    }),
  )

  app.post<{ Params: { id: string; linkId: string } }>(
    `${base}/admin/users/:id/login-links/:linkId/revoke`,
    adminRoute(ctx, async (req, reply, session) => {
      await revokeLoginLink(db, req.params.linkId)
      await audit(db, session.user.username, 'login-link.revoked', req.params.id, { linkId: req.params.linkId })
      return reply.redirect(`${base}/admin/users/${req.params.id}`)
    }),
  )

  app.post<{ Params: { id: string; deviceId: string } }>(
    `${base}/admin/users/:id/devices/:deviceId/revoke`,
    adminRoute(ctx, async (req, reply, session) => {
      await revokeDevice(db, req.params.deviceId)
      await audit(db, session.user.username, 'device.revoked', req.params.id, { deviceId: req.params.deviceId })
      return reply.redirect(`${base}/admin/users/${req.params.id}`)
    }),
  )

  app.post<{ Params: { id: string } }>(
    `${base}/admin/users/:id/block`,
    adminRoute(ctx, async (req, reply, session) => {
      if (req.params.id === session.user._id) return reply.code(400).send('Du kannst dich nicht selbst sperren.')
      await db.col.users.updateOne({ _id: req.params.id }, { $set: { status: 'blocked' } })
      await revokeAllDevices(db, req.params.id)
      await endLibrechatSessions(ctx, req.params.id)
      await audit(db, session.user.username, 'user.blocked', req.params.id)
      return reply.redirect(`${base}/admin/users/${req.params.id}`)
    }),
  )

  app.post<{ Params: { id: string } }>(
    `${base}/admin/users/:id/unblock`,
    adminRoute(ctx, async (req, reply, session) => {
      await db.col.users.updateOne({ _id: req.params.id }, { $set: { status: 'active' } })
      await audit(db, session.user.username, 'user.unblocked', req.params.id)
      return reply.redirect(`${base}/admin/users/${req.params.id}`)
    }),
  )

  app.get(
    `${base}/admin/audit`,
    adminRoute(ctx, async (_req, reply, session) => {
      const entries = await db.col.audit.find().sort({ at: -1 }).limit(200).toArray()
      const csrf = csrfField(config, session)
      return sendHtml(
        reply,
        page(
          'Protokoll',
          html`<h1>Protokoll</h1>
            <div class="card table-wrap"><table>
              <thead><tr><th>Zeit</th><th>Wer</th><th>Aktion</th><th>Details</th></tr></thead>
              <tbody>${entries.map(
                (e) => html`<tr><td>${formatDate(e.at)}</td><td>${e.actor}</td><td>${e.action}</td><td class="muted">${JSON.stringify(e.details)}</td></tr>`,
              )}</tbody>
            </table></div>`,
          { nav: adminNav(base, 'audit', session, csrf) },
        ),
      )
    }),
  )
}
