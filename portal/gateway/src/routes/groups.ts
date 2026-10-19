import type { FastifyInstance } from 'fastify'
import { html, page } from '../html.js'
import {
  INVITE_STATE_TEXT,
  createGroup,
  createInvite,
  formatBerlinLocal,
  inviteState,
  inviteToken,
  parseBerlinLocal,
} from '../invites.js'
import { UserError, audit } from '../users.js'
import { type AppContext, csrfField, field, formatDate, qrSvg, sendHtml } from '../web.js'
import { adminNav, adminRoute } from './admin.js'

function money(value: number): string {
  return `${value.toFixed(2)} $`
}

function amount(body: unknown, name: string, fallback: number): number {
  const value = Number(field(body, name).replace(',', '.'))
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

export function registerGroupRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, db } = ctx
  const base = config.basePath

  app.get<{ Querystring: { error?: string } }>(
    `${base}/admin/groups`,
    adminRoute(ctx, async (req, reply, session) => {
      const groups = await db.col.groups.find().sort({ createdAt: -1 }).toArray()
      const counts = new Map(
        (await db.col.users.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$groupId', n: { $sum: 1 } } }]).toArray()).map(
          (r) => [r._id, r.n],
        ),
      )
      const csrf = csrfField(config, session)
      return sendHtml(
        reply,
        page(
          'Gruppen',
          html`<h1>Gruppen & Einladungen</h1>
            <form method="post" action="${base}/admin/groups" class="card">
              ${csrf}
              <h2 style="margin-top:0">Neue Gruppe</h2>
              ${req.query.error ? html`<p class="error">${req.query.error}</p>` : ''}
              <div class="row">
                <div><label for="name">Name</label><input id="name" name="name" maxlength="60" required></div>
                <div><label for="defaultStartBudgetUsd">Startbudget pro Person (USD)</label><input id="defaultStartBudgetUsd" name="defaultStartBudgetUsd" type="number" min="0" step="0.01" value="5"></div>
                <div><label for="defaultMonthlyBudgetUsd">Monatsbudget pro Person (USD)</label><input id="defaultMonthlyBudgetUsd" name="defaultMonthlyBudgetUsd" type="number" min="0" step="0.01" value="5"></div>
              </div>
              <button type="submit">Gruppe anlegen</button>
            </form>
            <div class="card table-wrap"><table>
              <thead><tr><th>Gruppe</th><th>Mitglieder</th><th>Startbudget</th><th>Monatsbudget</th><th>Angelegt</th></tr></thead>
              <tbody>${groups.map(
                (g) => html`<tr>
                  <td><a href="${base}/admin/groups/${g._id}">${g.name}</a></td><td>${counts.get(g._id) ?? 0}</td>
                  <td>${money(g.defaultStartBudgetUsd)}</td><td>${money(g.defaultMonthlyBudgetUsd)}</td><td>${formatDate(g.createdAt)}</td>
                </tr>`,
              )}</tbody>
            </table></div>`,
          { nav: adminNav(base, 'groups', session, csrf) },
        ),
      )
    }),
  )

  app.post(
    `${base}/admin/groups`,
    adminRoute(ctx, async (req, reply, session) => {
      try {
        const group = await createGroup(db, {
          name: field(req.body, 'name'),
          defaultStartBudgetUsd: amount(req.body, 'defaultStartBudgetUsd', 0),
          defaultMonthlyBudgetUsd: amount(req.body, 'defaultMonthlyBudgetUsd', 0),
          createdBy: session.user._id,
        })
        await audit(db, session.user.username, 'group.created', group._id, { name: group.name })
        return reply.redirect(`${base}/admin/groups/${group._id}`)
      } catch (error) {
        if (error instanceof UserError) return reply.redirect(`${base}/admin/groups?error=${encodeURIComponent(error.message)}`)
        throw error
      }
    }),
  )

  app.get<{ Params: { id: string }; Querystring: { error?: string; show?: string } }>(
    `${base}/admin/groups/:id`,
    adminRoute(ctx, async (req, reply, session) => {
      const group = await db.col.groups.findOne({ _id: req.params.id })
      if (!group) return reply.code(404).send('Gruppe nicht gefunden')
      const [invites, members] = await Promise.all([
        db.col.invites.find({ groupId: group._id }).sort({ createdAt: -1 }).toArray(),
        db.col.users.find({ groupId: group._id }).sort({ createdAt: 1 }).toArray(),
      ])
      const shown = invites.find((i) => i._id === req.query.show)
      const shownUrl = shown ? `${config.PUBLIC_URL}${base}/join/${inviteToken(config.PORTAL_SECRET, shown)}` : null
      const now = new Date()
      const csrf = csrfField(config, session)
      return sendHtml(
        reply,
        page(
          group.name,
          html`<h1>Gruppe ${group.name}</h1>
            ${
              shown && shownUrl
                ? html`<div class="card" id="invite-qr">
                    <h2 style="margin-top:0">Einladungs-QR${shown.note ? html` – ${shown.note}` : ''}</h2>
                    <p>${shown.maxUses - shown.uses} von ${shown.maxUses} Plätzen frei ·
                      gültig ${formatDate(shown.validFrom)} – ${formatDate(shown.validUntil)} Uhr</p>
                    <div class="qr">${await qrSvg(shownUrl)}</div>
                    <p><code id="invite-link">${shownUrl}</code></p>
                    <button class="secondary" onclick="window.print()">Drucken</button>
                  </div>`
                : ''
            }
            <form method="post" action="${base}/admin/groups/${group._id}/invites" class="card">
              ${csrf}
              <h2 style="margin-top:0">Neue Einladung (QR-Code)</h2>
              ${req.query.error ? html`<p class="error">${req.query.error}</p>` : ''}
              <div class="row">
                <div><label for="maxUses">Wie viele Personen</label><input id="maxUses" name="maxUses" type="number" min="1" max="500" value="3" required></div>
                <div><label for="validFrom">Gültig ab</label><input id="validFrom" name="validFrom" type="datetime-local" value="${formatBerlinLocal(now)}" required></div>
                <div><label for="validUntil">Gültig bis</label><input id="validUntil" name="validUntil" type="datetime-local" value="${formatBerlinLocal(new Date(now.getTime() + 86_400_000))}" required></div>
              </div>
              <div class="row">
                <div><label for="startBudgetUsd">Startbudget pro Person (USD)</label><input id="startBudgetUsd" name="startBudgetUsd" type="number" min="0" step="0.01" value="${group.defaultStartBudgetUsd}"></div>
                <div><label for="monthlyBudgetUsd">Monatsbudget pro Person (USD)</label><input id="monthlyBudgetUsd" name="monthlyBudgetUsd" type="number" min="0" step="0.01" value="${group.defaultMonthlyBudgetUsd}"></div>
                <div><label for="note">Notiz (z. B. Workshop)</label><input id="note" name="note" maxlength="100"></div>
              </div>
              <p class="muted">Zeiten in deutscher Zeit (Europe/Berlin).</p>
              <button type="submit">Einladung erstellen</button>
            </form>

            <h2>Einladungen</h2>
            <div class="card table-wrap"><table>
              <thead><tr><th>Notiz</th><th>Plätze</th><th>Gültig</th><th>Status</th><th></th></tr></thead>
              <tbody>${invites.map((i) => {
                const state = inviteState(i, now)
                return html`<tr>
                  <td>${i.note || '–'}</td><td>${i.uses} / ${i.maxUses}</td>
                  <td>${formatDate(i.validFrom)} – ${formatDate(i.validUntil)}</td>
                  <td class="${state === 'active' ? 'ok' : 'muted'}">${INVITE_STATE_TEXT[state]}</td>
                  <td>
                    ${state === 'active' || state === 'not-yet' ? html`<a href="${base}/admin/groups/${group._id}?show=${i._id}#invite-qr">QR anzeigen</a>` : ''}
                    ${
                      i.revokedAt || state === 'expired'
                        ? ''
                        : html`<form method="post" action="${base}/admin/groups/${group._id}/invites/${i._id}/revoke" class="inline">${csrf}<button class="secondary">Zurückziehen</button></form>`
                    }
                  </td>
                </tr>`
              })}</tbody>
            </table></div>

            <h2>Mitglieder</h2>
            <div class="card table-wrap"><table>
              <thead><tr><th>Benutzer</th><th>Monatsbudget</th><th>Beigetreten</th></tr></thead>
              <tbody>${members.map(
                (m) => html`<tr><td><a href="${base}/admin/users/${m._id}">${m.username}</a></td><td>${money(m.monthlyBudgetUsd)}</td><td>${formatDate(m.createdAt)}</td></tr>`,
              )}</tbody>
            </table></div>`,
          { nav: adminNav(base, 'groups', session, csrf) },
        ),
      )
    }),
  )

  app.post<{ Params: { id: string } }>(
    `${base}/admin/groups/:id/invites`,
    adminRoute(ctx, async (req, reply, session) => {
      const group = await db.col.groups.findOne({ _id: req.params.id })
      if (!group) return reply.code(404).send('Gruppe nicht gefunden')
      const back = (error: string) => reply.redirect(`${base}/admin/groups/${group._id}?error=${encodeURIComponent(error)}`)
      const validFrom = parseBerlinLocal(field(req.body, 'validFrom'))
      const validUntil = parseBerlinLocal(field(req.body, 'validUntil'))
      if (!validFrom || !validUntil) return back('Bitte Beginn und Ende angeben.')
      try {
        const { invite } = await createInvite(db, config.PORTAL_SECRET, {
          groupId: group._id,
          maxUses: Number(field(req.body, 'maxUses')) || 1,
          validFrom,
          validUntil,
          startBudgetUsd: amount(req.body, 'startBudgetUsd', group.defaultStartBudgetUsd),
          monthlyBudgetUsd: amount(req.body, 'monthlyBudgetUsd', group.defaultMonthlyBudgetUsd),
          note: field(req.body, 'note'),
          createdBy: session.user._id,
        })
        await audit(db, session.user.username, 'invite.created', group._id, {
          inviteId: invite._id,
          maxUses: invite.maxUses,
          validFrom: invite.validFrom,
          validUntil: invite.validUntil,
        })
        return reply.redirect(`${base}/admin/groups/${group._id}?show=${invite._id}#invite-qr`)
      } catch (error) {
        if (error instanceof UserError) return back(error.message)
        throw error
      }
    }),
  )

  app.post<{ Params: { id: string; inviteId: string } }>(
    `${base}/admin/groups/:id/invites/:inviteId/revoke`,
    adminRoute(ctx, async (req, reply, session) => {
      await db.col.invites.updateOne({ _id: req.params.inviteId, revokedAt: null }, { $set: { revokedAt: new Date() } })
      await audit(db, session.user.username, 'invite.revoked', req.params.id, { inviteId: req.params.inviteId })
      return reply.redirect(`${base}/admin/groups/${req.params.id}`)
    }),
  )
}
