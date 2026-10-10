import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/storage/database'
import { ChatRepository } from '../src/main/storage/chat-repository'
import type { Attachment } from '@shared/schemas/chat'

function repo(start = 1000) {
  let t = start
  return new ChatRepository(openDatabase(':memory:'), () => t++)
}

const attachment: Attachment = {
  id: 'a1',
  name: 'bild.png',
  mimeType: 'image/png',
  size: 10,
  kind: 'image',
  path: '/data/chats/c1/attachments/a1-bild.png',
}

describe('ChatRepository', () => {
  it('creates chats and lists them newest first', () => {
    const r = repo()
    r.create({ id: 'c1', title: 'Erster', provider: 'anthropic', model: 'Standard' })
    r.create({ id: 'c2', title: 'Zweiter', provider: 'openrouter', model: 'x/y' })
    expect(r.list().map((c) => c.id)).toEqual(['c2', 'c1'])
    expect(r.exists('c1')).toBe(true)
    expect(r.exists('nope')).toBe(false)
  })

  it('stores messages with attachments, tools and cost', () => {
    const r = repo()
    r.create({ id: 'c1', title: 'T', provider: 'anthropic', model: 'm' })
    r.addMessage({ chatId: 'c1', role: 'user', text: 'Hallo', attachments: [attachment] })
    r.addMessage({
      chatId: 'c1',
      role: 'assistant',
      parts: [
        {
          type: 'tool',
          call: {
            id: 't1',
            name: 'Read',
            input: { file_path: 'a.ts' },
            result: 'x',
            isError: false,
          },
        },
        { type: 'text', text: 'Hi' },
      ],
      costUsd: 0.01,
      durationMs: 1200,
    })
    r.addMessage({ chatId: 'c1', role: 'assistant', text: '', costUsd: 0.02, error: 'boom' })

    const chat = r.get('c1')
    expect(chat?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(chat?.messages[0]?.attachments).toEqual([attachment])
    expect(chat?.messages[1]?.parts.map((p) => p.type)).toEqual(['tool', 'text'])
    // The plain text column is derived from the text parts.
    expect(chat?.messages[1]?.text).toBe('Hi')
    expect(chat?.messages[2]?.error).toBe('boom')
    expect(chat?.totalCostUsd).toBeCloseTo(0.03)
  })

  it('bumps updatedAt on new messages so the chat moves to the top', () => {
    const r = repo()
    r.create({ id: 'c1', title: 'A', provider: 'anthropic', model: 'm' })
    r.create({ id: 'c2', title: 'B', provider: 'anthropic', model: 'm' })
    r.addMessage({ chatId: 'c1', role: 'user', text: 'neu' })
    expect(r.list()[0]?.id).toBe('c1')
  })

  it('creates coding chats with project folder and permission mode', () => {
    const r = repo()
    r.create({
      id: 'p1',
      title: 'Projekt',
      provider: 'anthropic',
      model: 'm',
      mode: 'code',
      projectPath: '/work/app',
    })
    expect(r.summary('p1')).toMatchObject({
      mode: 'code',
      projectPath: '/work/app',
      permissionMode: 'default',
    })
    r.setPermissionMode('p1', 'acceptEdits')
    expect(r.summary('p1')?.permissionMode).toBe('acceptEdits')
  })

  it('reads messages written by schema v1 (text + tool names)', () => {
    const db = openDatabase(':memory:')
    const r = new ChatRepository(db)
    r.create({ id: 'c1', title: 'Alt', provider: 'anthropic', model: 'm' })
    db.prepare(
      `INSERT INTO messages (id, chat_id, role, text, tools_json, created_at)
       VALUES ('m1', 'c1', 'assistant', 'Alte Antwort', '["Read"]', 1)`,
    ).run()
    const parts = r.get('c1')?.messages[0]?.parts
    expect(parts?.map((p) => p.type)).toEqual(['tool', 'text'])
  })

  it('remembers the SDK session id for resuming', () => {
    const r = repo()
    r.create({ id: 'c1', title: 'A', provider: 'anthropic', model: 'm' })
    expect(r.getSdkSessionId('c1')).toBeUndefined()
    r.setSdkSessionId('c1', 'sdk-123')
    expect(r.getSdkSessionId('c1')).toBe('sdk-123')
  })

  it('renames and deletes chats including their messages', () => {
    const r = repo()
    r.create({ id: 'c1', title: 'A', provider: 'anthropic', model: 'm' })
    r.addMessage({ chatId: 'c1', role: 'user', text: 'x' })
    r.rename('c1', 'Neu')
    expect(r.get('c1')?.title).toBe('Neu')
    r.delete('c1')
    expect(r.get('c1')).toBeUndefined()
    expect(r.list()).toEqual([])
  })

  it('is idempotent when reopening a migrated database file', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'aiw-db-'))
    const file = join(dir, 'w.db')
    const first = openDatabase(file)
    new ChatRepository(first).create({ id: 'c', title: 't', provider: 'ollama', model: 'm' })
    first.close()
    const second = openDatabase(file)
    expect(new ChatRepository(second).list()).toHaveLength(1)
    second.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
