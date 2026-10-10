import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { DEFAULT_SETTINGS, type Settings } from '@shared/schemas/settings'
import type { AgentEvent } from '@shared/schemas/agent'
import { chatAttachmentsDir, SessionManager } from '../../src/main/agent/session-manager'
import { resolveClaudeExecutable } from '../../src/main/agent/executable'
import { ChatRepository } from '../../src/main/storage/chat-repository'
import { openDatabase } from '../../src/main/storage/database'
import { SecretStore } from '../../src/main/storage/secret-store'
import { storeAttachment } from '../../src/main/workspace/attachments'
import { createWordDocument } from '../../src/main/documents/create'
import { startMockAnthropic, type MockAnthropic } from '../../scripts/mock-anthropic'

describe('office documents inside the agent (real runtime)', () => {
  let anthropic: MockAnthropic
  let dir: string
  let db: ReturnType<typeof openDatabase>
  let firstPrompt = ''
  let toolNames: string[] = []

  beforeAll(async () => {
    anthropic = await startMockAnthropic((raw) => {
      const body = raw as { tools?: { name: string }[]; messages?: unknown[] }
      toolNames = (body.tools ?? []).map((t) => t.name)
      const text = JSON.stringify(body.messages ?? [])
      if (!text.includes('"tool_result"')) {
        firstPrompt = text
        return {
          toolUse: {
            name: 'mcp__media__create_spreadsheet',
            input: {
              file_name: 'umsatz',
              sheets: [
                {
                  name: 'Quartale',
                  rows: [
                    ['Quartal', 'Umsatz'],
                    ['Q1', 1200],
                    ['Q2', 1500],
                    ['Summe', '=SUM(B2:B3)'],
                  ],
                },
              ],
            },
          },
        }
      }
      return { text: 'Die Tabelle ist fertig.' }
    })
    dir = mkdtempSync(join(tmpdir(), 'aiw-docs-agent-'))
    db = openDatabase(join(dir, 'w.db'))
  })

  afterAll(async () => {
    await anthropic.close()
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('reads an attached Word file and creates an Excel workbook', async () => {
    const docx = await createWordDocument({
      markdown: '# Quartalsbericht\n\n| Quartal | Umsatz |\n| --- | --- |\n| Q1 | 1200 |',
    })
    const attachment = storeAttachment(
      {
        source: 'data',
        name: 'bericht.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        base64: docx.toString('base64'),
      },
      chatAttachmentsDir(dir, 'd1'),
    )
    expect(attachment.kind).toBe('document')
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      activeProvider: 'ollama',
      ollamaBaseUrl: anthropic.url,
      models: { ...DEFAULT_SETTINGS.models, ollama: 'mock-model' },
      webAccess: false,
    }
    const events: AgentEvent[] = []
    const manager = new SessionManager({
      getSettings: () => settings,
      secrets: new SecretStore(join(dir, 's.json'), {
        isAvailable: () => true,
        encrypt: (s) => Buffer.from(s),
        decrypt: (b) => b.toString(),
      }),
      chats: new ChatRepository(db),
      dataDir: dir,
      appVersion: 'test',
      executablePath: resolveClaudeExecutable(),
      emit: (e) => events.push(e),
    })

    manager.send({ chatId: 'd1', prompt: 'Mach daraus eine Tabelle', attachments: [attachment] })
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!manager.isRunning('d1')) {
          clearInterval(timer)
          resolve()
        }
      }, 50)
    })

    // The Word content reached the model as Markdown, even for a local (Ollama) model.
    expect(firstPrompt).toContain('<document name=\\"bericht.docx\\"')
    expect(firstPrompt).toContain('# Quartalsbericht')
    expect(firstPrompt).toContain('| Q1 | 1200 |')
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'mcp__media__read_document',
        'mcp__media__create_word_document',
        'mcp__media__create_presentation',
      ]),
    )
    expect(events.some((e) => e.type === 'permission-request')).toBe(false)
    const files = events.flatMap((e) => (e.type === 'output-file' ? [e.file] : []))
    expect(files.map((f) => f.name)).toEqual(['umsatz.xlsx'])
    const book = XLSX.read(readFileSync(files[0]?.path ?? ''), {
      cellFormula: true,
      sheetStubs: true,
    })
    const sheet = book.Sheets['Quartale']
    expect(sheet?.B4?.f).toBe('SUM(B2:B3)')
    expect(sheet?.B2?.v).toBe(1200)
  }, 120_000)
})
