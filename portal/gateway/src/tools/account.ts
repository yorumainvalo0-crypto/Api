import { defineTool, textResult } from '../mcp.js'

/** 1 USD = 1,000,000 LibreChat credits */
export const CREDITS_PER_USD = 1_000_000

export const accountStatusTool = defineTool({
  name: 'konto_status',
  title: 'Konto-Status',
  description:
    'Zeigt dem Nutzer sein verbleibendes Guthaben in US-Dollar, sein Monatsbudget und wann es zurückgesetzt wird. ' +
    'Nutze das Werkzeug, wenn der Nutzer nach Guthaben, Budget, Limit oder Kosten fragt.',
  inputSchema: {},
  async run(_args, { db, user, librechatUserId }) {
    const balance = await db.librechat.collection('balances').findOne({ user: librechatUserId })
    const remainingUsd = (Number(balance?.tokenCredits ?? 0) || 0) / CREDITS_PER_USD
    const lines = [
      `Benutzer: ${user.username}`,
      `Verbleibendes Guthaben: ${remainingUsd.toFixed(2)} USD`,
      `Monatsbudget: ${user.monthlyBudgetUsd.toFixed(2)} USD`,
      `Nächste Aufladung: ${user.nextResetAt ? user.nextResetAt.toISOString().slice(0, 10) : 'keine geplant'}`,
    ]
    return textResult(lines.join('\n'))
  },
})
