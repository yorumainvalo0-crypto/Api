import { remainingUsd } from '../budgets.js'
import { defineTool, textResult } from '../mcp.js'

export const accountStatusTool = defineTool({
  name: 'konto_status',
  title: 'Konto-Status',
  description:
    'Zeigt dem Nutzer sein verbleibendes Guthaben in US-Dollar, sein Monatsbudget und wann es zurückgesetzt wird. ' +
    'Nutze das Werkzeug, wenn der Nutzer nach Guthaben, Budget, Limit oder Kosten fragt.',
  inputSchema: {},
  async run(_args, { db, user, librechatUserId }) {
    const remaining = await remainingUsd(db, librechatUserId)
    const lines = [
      `Benutzer: ${user.username}`,
      `Verbleibendes Guthaben: ${remaining.toFixed(2)} USD`,
      `Monatsbudget: ${user.monthlyBudgetUsd.toFixed(2)} USD`,
      `Nächste Aufladung: ${user.nextResetAt ? user.nextResetAt.toISOString().slice(0, 10) : 'keine geplant'}`,
    ]
    return textResult(lines.join('\n'))
  },
})
