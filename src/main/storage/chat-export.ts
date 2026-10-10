import type { ChatDetail, MessagePart } from '@shared/schemas/chat'

function formatDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
}

function toolSummary(part: Extract<MessagePart, { type: 'tool' }>): string {
  const input = JSON.stringify(part.call.input ?? {})
  const shortInput = input.length > 300 ? `${input.slice(0, 300)} …` : input
  const status = part.call.result === null ? '' : part.call.isError ? ' ❌' : ' ✅'
  return `> 🔧 **${part.call.name}**${status} \`${shortInput}\``
}

/** Renders a chat as a readable Markdown document. */
export function chatToMarkdown(chat: ChatDetail): string {
  const lines = [
    `# ${chat.title}`,
    '',
    `- Erstellt: ${formatDate(chat.createdAt)} UTC`,
    `- Modell: ${chat.provider} · ${chat.model}`,
    ...(chat.projectPath ? [`- Projekt: ${chat.projectPath}`] : []),
    ...(chat.totalCostUsd > 0 ? [`- Kosten: $${chat.totalCostUsd.toFixed(4)}`] : []),
    '',
  ]
  for (const m of chat.messages) {
    lines.push('---', '', m.role === 'user' ? '## 🧑 Du' : '## 🤖 Assistent', '')
    if (m.role === 'user') {
      if (m.text) lines.push(m.text, '')
      for (const a of m.attachments) lines.push(`📎 ${a.name} (${a.mimeType})`)
      if (m.attachments.length) lines.push('')
      continue
    }
    for (const part of m.parts) {
      if (part.type === 'text') lines.push(part.text, '')
      else if (part.type === 'tool') lines.push(toolSummary(part), '')
      else lines.push(`🖼️ Datei: ${part.file.name} (${part.file.path})`, '')
    }
    if (m.error) lines.push(`> ⚠️ Fehler: ${m.error}`, '')
  }
  return `${lines.join('\n').trim()}\n`
}

/** File-name friendly version of a chat title. */
export function exportFileName(title: string, ext: string): string {
  const base = title
    .replace(/[<>:"/\\|?*]/g, '_')
    // eslint-disable-next-line no-control-regex -- strip control characters
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^💻\s*/u, '')
    .trim()
    .slice(0, 80)
  return `${base || 'chat'}.${ext}`
}
