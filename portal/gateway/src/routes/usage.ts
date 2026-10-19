import type { FastifyInstance } from 'fastify'
import { html, page, raw, type SafeHtml } from '../html.js'
import { RANGES, type UsageReport, type UsageRow, resolveRange, usageCsv, usageReport } from '../usage.js'
import { type AppContext, csrfField, sendHtml } from '../web.js'
import { adminNav, adminRoute } from './admin.js'

const usd = (value: number) => `${value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 4 : 2 })} $`
const count = (value: number) => value.toLocaleString('de-DE')

/** Chart tokens: one sequential blue, recessive grid; dark mode has its own validated step. */
const CHART_STYLE = `
.viz { --series-1:#2a78d6; --grid:#e4e4df; --axis-text:#6b6b66; }
@media (prefers-color-scheme: dark) { .viz { --series-1:#3987e5; --grid:#3a3a37; --axis-text:#a3a39d; } }
.viz svg { width:100%; height:auto; display:block; }
.viz .bar { fill:var(--series-1); }
.viz .hit { fill:transparent; cursor:default; }
.viz g:hover .bar { opacity:.8; }
.viz .gridline { stroke:var(--grid); stroke-width:1; }
.viz text { fill:var(--axis-text); font-size:11px; font-family:inherit; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin:12px 0; }
.tile { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
.tile .value { font-size:1.6rem; font-weight:700; margin-top:2px; }
.filters { display:flex; gap:12px; flex-wrap:wrap; align-items:end; }
.filters > div { flex: 0 1 220px; }
.filters > div.actions { flex: 0 0 auto; display:flex; gap:12px; }
.filters button, .filters .button { margin-top:0; }
.cellbar { min-width:180px; }
.cellbar .wrap { display:flex; align-items:center; gap:8px; }
.cellbar .text { flex:0 0 72px; text-align:right; font-variant-numeric:tabular-nums; }
.cellbar .track { flex:1 1 auto; min-width:60px; }
.cellbar .fill { display:block; height:8px; border-radius:0 4px 4px 0; background:var(--series-1); }
.num { text-align:right; font-variant-numeric: tabular-nums; }
#tooltip { position:fixed; pointer-events:none; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-size:.85rem; box-shadow:0 4px 16px rgba(0,0,0,.15); display:none; z-index:10; }
`

function niceMax(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude
  }
  return 10 * magnitude
}

function bucketText(bucket: string, unit: 'hour' | 'day'): { short: string; long: string } {
  if (unit === 'hour') {
    const hour = bucket.slice(11, 13)
    return { short: `${hour}`, long: `${hour}:00–${hour}:59 Uhr` }
  }
  const [y, m, d] = bucket.split('-')
  return { short: `${d}.${m}.`, long: `${d}.${m}.${y}` }
}

function costChart(report: UsageReport): SafeHtml {
  const width = 900
  const height = 260
  const left = 56
  const bottom = 26
  const top = 10
  const plotW = width - left - 8
  const plotH = height - top - bottom
  const series = report.series
  const max = niceMax(Math.max(...series.map((s) => s.costUsd), 0))
  const band = plotW / Math.max(series.length, 1)
  // Thin marks: at most 40px wide, centred in the band, 2px gap between neighbours
  const barW = Math.max(1, Math.min(40, band - 2))
  const labelEvery = Math.ceil(series.length / 10)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max)

  const grid = ticks
    .map((t) => {
      const y = top + plotH - (t / max) * plotH
      return `<line class="gridline" x1="${left}" x2="${width - 8}" y1="${y}" y2="${y}"/><text x="${left - 6}" y="${y + 4}" text-anchor="end">${usd(t)}</text>`
    })
    .join('')
  const bars = series
    .map((s, i) => {
      const x = left + i * band + (band - barW) / 2
      const h = (s.costUsd / max) * plotH
      const y = top + plotH - h
      const r = Math.min(4, h / 2, barW / 2)
      // Rounded data end (top), square at the baseline
      const path =
        h > 0
          ? `M${x},${top + plotH} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${top + plotH} Z`
          : ''
      const label = bucketText(s.bucket, report.range.unit)
      const tip = `${label.long}: ${usd(s.costUsd)} · ${count(s.inputTokens)} Tokens rein · ${count(s.outputTokens)} Tokens raus`
      const xLabel =
        i % labelEvery === 0
          ? `<text x="${x + barW / 2}" y="${height - 8}" text-anchor="middle">${label.short}</text>`
          : ''
      // The transparent hit area lies on top of the bar so hovering the bar itself shows the tooltip
      return `<g>${path ? `<path class="bar" d="${path}"/>` : ''}${xLabel}<rect class="hit" x="${left + i * band}" y="${top}" width="${band}" height="${plotH}" data-tip="${tip}"><title>${tip}</title></rect></g>`
    })
    .join('')
  return raw(
    `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Kosten pro ${report.range.unit === 'hour' ? 'Stunde' : 'Tag'} in US-Dollar">${grid}${bars}</svg>`,
  )
}

function rowsTable(rows: UsageRow[], firstHeader: string, extra?: { header: string; cell: (row: UsageRow) => SafeHtml | string }[]): SafeHtml {
  const max = Math.max(...rows.map((r) => r.costUsd), 0) || 1
  return html`<div class="table-wrap"><table>
    <thead><tr><th>${firstHeader}</th>${extra?.map((e) => html`<th>${e.header}</th>`)}<th>Kosten</th><th class="num">Tokens rein</th><th class="num">Tokens raus</th><th class="num">Anfragen</th></tr></thead>
    <tbody>${rows.map(
      (r) => html`<tr>
        <td>${r.label}</td>${extra?.map((e) => html`<td>${e.cell(r)}</td>`)}
        <td class="cellbar"><div class="wrap"><span class="text">${usd(r.costUsd)}</span><span class="track"><span class="fill" style="width:${Math.max(2, (r.costUsd / max) * 100).toFixed(1)}%"></span></span></div></td>
        <td class="num">${count(r.inputTokens)}</td><td class="num">${count(r.outputTokens)}</td><td class="num">${count(r.requests)}</td>
      </tr>`,
    )}</tbody>
  </table></div>`
}

const TOOLTIP_SCRIPT = `
const tip = document.getElementById('tooltip');
document.querySelectorAll('.viz .hit').forEach((hit) => {
  hit.addEventListener('mousemove', (e) => {
    tip.textContent = hit.dataset.tip; tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8) + 'px';
    tip.style.top = (e.clientY - tip.offsetHeight - 12) + 'px';
  });
  hit.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
});
`

export function registerUsageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, db } = ctx
  const base = config.basePath

  app.get<{ Querystring: { range?: string; group?: string } }>(
    `${base}/admin/usage`,
    adminRoute(ctx, async (req, reply, session) => {
      const range = resolveRange(req.query.range)
      const groupId = req.query.group || null
      const [report, groups] = await Promise.all([usageReport(db, range, groupId), db.col.groups.find().sort({ name: 1 }).toArray()])
      const csrf = csrfField(config, session)
      const query = new URLSearchParams({ range: range.key, ...(groupId ? { group: groupId } : {}) }).toString()
      return sendHtml(
        reply,
        page(
          'Verbrauch',
          html`<style>${raw(CHART_STYLE)}</style>
            <h1>Verbrauch</h1>
            <form method="get" class="card filters">
              <div><label for="range">Zeitraum</label>
                <select id="range" name="range">${Object.entries(RANGES).map(
                  ([key, label]) => html`<option value="${key}" ${raw(key === range.key ? 'selected' : '')}>${label}</option>`,
                )}</select></div>
              <div><label for="group">Gruppe</label>
                <select id="group" name="group"><option value="">Alle</option>${groups.map(
                  (g) => html`<option value="${g._id}" ${raw(g._id === groupId ? 'selected' : '')}>${g.name}</option>`,
                )}</select></div>
              <div class="actions"><button type="submit">Anzeigen</button>
                <a class="button" style="background:transparent;color:var(--accent);border:1px solid var(--accent)" href="${base}/admin/usage.csv?${query}">CSV herunterladen</a></div>
            </form>

            <div class="tiles">
              <div class="tile"><div class="muted">Kosten</div><div class="value" id="total-cost">${usd(report.totals.costUsd)}</div></div>
              <div class="tile"><div class="muted">Tokens rein</div><div class="value">${count(report.totals.inputTokens)}</div></div>
              <div class="tile"><div class="muted">Tokens raus</div><div class="value">${count(report.totals.outputTokens)}</div></div>
              <div class="tile"><div class="muted">Anfragen</div><div class="value">${count(report.totals.requests)}</div></div>
              <div class="tile"><div class="muted">Aktive Personen</div><div class="value">${count(report.totals.activeUsers)}</div></div>
            </div>

            <div class="card viz">
              <h2 style="margin-top:0">Kosten pro ${range.unit === 'hour' ? 'Stunde' : 'Tag'} (USD)</h2>
              ${costChart(report)}
            </div>

            <h2>Nach Person</h2>
            <div class="card viz" id="by-user">${rowsTable(report.byUser, 'Benutzer', [
              { header: 'Gruppe', cell: (r) => (r as UsageReport['byUser'][number]).group },
              {
                header: 'Guthaben',
                cell: (r) => {
                  const remaining = (r as UsageReport['byUser'][number]).remainingUsd
                  return remaining === null ? '–' : usd(remaining)
                },
              },
            ])}</div>

            <h2>Nach Modell</h2>
            <div class="card viz" id="by-model">${rowsTable(report.byModel, 'Modell')}</div>

            <h2>Nach Gruppe</h2>
            <div class="card viz" id="by-group">${rowsTable(report.byGroup, 'Gruppe')}</div>
            <p class="muted">Kosten wie von LibreChat gebucht (Listenpreise je Modell). Zeiten in deutscher Zeit.</p>
            <div id="tooltip" role="tooltip"></div>
            <script>${raw(TOOLTIP_SCRIPT)}</script>`,
          { nav: adminNav(base, 'usage', session, csrf) },
        ),
      )
    }),
  )

  app.get<{ Querystring: { range?: string; group?: string } }>(
    `${base}/admin/usage.csv`,
    adminRoute(ctx, async (req, reply) => {
      const range = resolveRange(req.query.range)
      const csv = await usageCsv(db, range, req.query.group || null)
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="verbrauch-${range.key}.csv"`)
        .send(csv)
    }),
  )
}
