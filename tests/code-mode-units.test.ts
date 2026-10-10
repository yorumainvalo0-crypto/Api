import { describe, expect, it } from 'vitest'
import { findDangerousCommand, PermissionBroker } from '../src/main/agent/permissions'
import { normalizeSdkMessage } from '../src/main/agent/normalize'
import { applyReplyEvent, EMPTY_REPLY, partsToText, type ReplyState } from '@shared/message-parts'
import { diffLines } from '@shared/line-diff'
import type { AgentEvent } from '@shared/schemas/agent'

describe('findDangerousCommand', () => {
  it.each([
    'rm -rf /',
    'rm -rf ~',
    'sudo rm -fr / --no-preserve-root',
    'rm -rf $HOME',
    'rm -r -f /*',
    'Remove-Item -Recurse -Force C:\\',
    'Remove-Item $env:USERPROFILE -Recurse -Force',
    'rd /s /q C:\\',
    'del /f /s /q C:\\*',
    'format C: /q',
    'Format-Volume -DriveLetter D',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda bs=1M',
    'shutdown /s /t 0',
    'Stop-Computer -Force',
    ':(){ :|:& };:',
    'reg delete HKLM\\Software\\Foo /f',
    'ls && rm -rf ~/',
    'cd /tmp; sudo rm -R /etc',
    'Remove-Item -Path C:\\ -Recurse',
    'rmdir /s /q C:\\Users',
    'ri -r -fo $HOME',
  ])('blocks %s', (command) => {
    expect(findDangerousCommand(command)).toBeTruthy()
  })

  it.each([
    'rm -rf node_modules',
    'rm -rf ./dist build',
    'Remove-Item -Recurse -Force .\\out',
    'npm run build',
    'git status',
    'del temp.txt',
    'rd /s /q dist',
    'echo shutdown-handler.ts',
    'npx prettier --write src/format.ts',
    'rm -rf /tmp/build',
    'rm -rf ./node_modules ~/project/dist',
    'Remove-Item -Recurse C:\\Users\\me\\project\\dist',
    'git log --format=%H',
  ])('allows %s', (command) => {
    expect(findDangerousCommand(command)).toBeUndefined()
  })
})

describe('PermissionBroker', () => {
  it('emits a request and resolves with the user decision', async () => {
    const events: AgentEvent[] = []
    const broker = new PermissionBroker((e) => events.push(e))
    const suggestions = [
      {
        type: 'addRules' as const,
        rules: [{ toolName: 'Bash' }],
        behavior: 'allow' as const,
        destination: 'session' as const,
      },
    ]
    const promise = broker.canUseTool('c1')(
      'Bash',
      { command: 'ls' },
      {
        signal: new AbortController().signal,
        suggestions,
        toolUseID: 't1',
        requestId: 'r1',
      },
    )
    const request = events.find((e) => e.type === 'permission-request')
    expect(request).toMatchObject({ toolName: 'Bash', input: { command: 'ls' } })
    if (request?.type !== 'permission-request') throw new Error('missing request')

    expect(broker.respond(request.requestId, 'allow-always')).toBe(true)
    await expect(promise).resolves.toEqual({ behavior: 'allow', updatedPermissions: suggestions })
    expect(events.at(-1)).toMatchObject({ type: 'permission-resolved' })
    // A second answer for the same request is ignored.
    expect(broker.respond(request.requestId, 'deny')).toBe(false)
  })

  it('denies open requests on abort and on denyAll', async () => {
    const broker = new PermissionBroker(() => undefined)
    const abort = new AbortController()
    const opts = { toolUseID: 't', requestId: 'r' }
    const aborted = broker.canUseTool('c1')('Write', {}, { signal: abort.signal, ...opts })
    const denied = broker.canUseTool('c2')(
      'Write',
      {},
      {
        signal: new AbortController().signal,
        ...opts,
      },
    )
    abort.abort()
    broker.denyAll('c2')
    await expect(aborted).resolves.toMatchObject({ behavior: 'deny', interrupt: true })
    await expect(denied).resolves.toMatchObject({ behavior: 'deny' })
    expect(broker.pendingCount()).toBe(0)
  })
})

describe('reply reducer', () => {
  // Distributes Omit over the union so each event variant keeps its own fields.
  type EventInput = AgentEvent extends infer E
    ? E extends AgentEvent
      ? Omit<E, 'chatId'>
      : never
    : never
  const ev = (e: EventInput): AgentEvent => ({ chatId: 'c', ...e }) as AgentEvent

  it('interleaves streamed text and tool calls in order', () => {
    let s: ReplyState = EMPTY_REPLY
    for (const e of [
      ev({ type: 'text-delta', text: 'Ich ' }),
      ev({ type: 'text-delta', text: 'lese.' }),
      ev({ type: 'assistant-text', text: 'Ich lese.' }),
      ev({ type: 'tool-use', toolUseId: 't1', name: 'Read', input: { file_path: 'a' } }),
      ev({ type: 'tool-result', toolUseId: 't1', content: 'inhalt', isError: false }),
      ev({ type: 'text-delta', text: 'Fertig.' }),
      ev({ type: 'result', isError: false, text: '', costUsd: 0.5, durationMs: 10 }),
    ]) {
      s = applyReplyEvent(s, e)
    }
    expect(s.parts).toEqual([
      { type: 'text', text: 'Ich lese.' },
      {
        type: 'tool',
        call: {
          id: 't1',
          name: 'Read',
          input: { file_path: 'a' },
          result: 'inhalt',
          isError: false,
        },
      },
      { type: 'text', text: 'Fertig.' },
    ])
    expect(partsToText(s.parts)).toBe('Ich lese.\n\nFertig.')
    expect(s.costUsd).toBe(0.5)
  })

  it('uses complete texts when the provider does not stream', () => {
    let s = applyReplyEvent(EMPTY_REPLY, ev({ type: 'assistant-text', text: 'A' }))
    s = applyReplyEvent(s, ev({ type: 'assistant-text', text: 'B' }))
    expect(partsToText(s.parts)).toBe('A\n\nB')
  })
})

describe('normalize tool results', () => {
  it('maps tool_result blocks from user messages', () => {
    expect(
      normalizeSdkMessage('c', {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] },
            { type: 'tool_result', tool_use_id: 't2', content: 'kaputt', is_error: true },
          ],
        },
      }),
    ).toEqual([
      { chatId: 'c', type: 'tool-result', toolUseId: 't1', content: 'ok', isError: false },
      { chatId: 'c', type: 'tool-result', toolUseId: 't2', content: 'kaputt', isError: true },
    ])
  })
})

describe('diffLines', () => {
  it('produces a minimal line diff', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'remove', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' },
    ])
    expect(diffLines('', 'neu')).toEqual([{ kind: 'add', text: 'neu' }])
  })
})
