import { useCallback, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import {
  Box,
  File as FileIcon,
  FileText,
  FolderCode,
  Images,
  PanelRight,
  Paperclip,
  Send,
  Square,
  Users,
  X,
} from 'lucide-react'
import {
  EFFORT_LABELS,
  EffortSchema,
  PROVIDER_LABELS,
  type Effort,
  type Settings,
} from '@shared/schemas/settings'
import {
  AgentPermissionModeSchema,
  PERMISSION_MODE_LABELS,
  type AgentPermissionMode,
  type Attachment,
  type AttachmentInput,
  type ChatMessage,
  type ChatSummary,
  type MessagePart,
} from '@shared/schemas/chat'
import { applyReplyEvent, EMPTY_REPLY, type ReplyState } from '@shared/message-parts'
import { fileUrl } from '@shared/ipc'
import { api } from '../../lib/api'
import { ModelPicker, cleanError } from '../../components/ModelPicker'
import { ContextMeter } from '../usage/ContextMeter'
import { RouteBadge } from './RouteBadge'
import { ProjectPanel } from '../project/ProjectPanel'
import { InlineMedia } from '../media/InlineMedia'
import { OutputsPanel } from '../media/OutputsPanel'
import { ToolCard } from './ToolCard'
import { PermissionPrompt, type PermissionRequest } from './PermissionPrompt'

export function ChatView(props: {
  chatId: string
  settings: Settings
  running: boolean
  onSettingsChange: (s: Settings) => void
}) {
  const { chatId, settings, running } = props
  const [chat, setChat] = useState<ChatSummary | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [totalCost, setTotalCost] = useState(0)
  const [live, setLive] = useState<ReplyState | null>(null)
  const [permissions, setPermissions] = useState<PermissionRequest[]>([])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<Attachment[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  /** Right panel: project tools (code mode) or generated outputs (both modes). */
  const [panel, setPanel] = useState<'project' | 'outputs' | null>(null)
  const [outputsVersion, setOutputsVersion] = useState(0)
  const bottomRef = useRef<HTMLDivElement>(null)

  const reload = useCallback(async () => {
    const detail = await api.invoke('chats:get', { chatId })
    setChat(detail)
    setMessages(detail?.messages ?? [])
    setTotalCost(detail?.totalCostUsd ?? 0)
  }, [chatId])

  // The view is keyed by chat id, so local state starts fresh for every chat.
  useEffect(() => {
    let cancelled = false
    void api.invoke('chats:get', { chatId }).then((detail) => {
      if (cancelled) return
      setChat(detail)
      setMessages(detail?.messages ?? [])
      setTotalCost(detail?.totalCostUsd ?? 0)
    })
    return () => {
      cancelled = true
    }
  }, [chatId])

  useEffect(() => {
    return api.on('agent:event', (event) => {
      if (event.chatId !== chatId) return
      switch (event.type) {
        case 'done':
          setPermissions([])
          setOutputsVersion((v) => v + 1)
          void reload().then(() => setLive(null))
          return
        case 'output-file':
          // Show new results right away.
          setOutputsVersion((v) => v + 1)
          setPanel((p) => p ?? 'outputs')
          setLive((prev) => applyReplyEvent(prev ?? EMPTY_REPLY, event))
          return
        case 'permission-request':
          setPermissions((prev) => [...prev, event])
          return
        case 'permission-resolved':
          setPermissions((prev) => prev.filter((p) => p.requestId !== event.requestId))
          return
        default:
          setLive((prev) => applyReplyEvent(prev ?? EMPTY_REPLY, event))
      }
    })
  }, [chatId, reload])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, live, permissions])

  const addFiles = async (files: AttachmentInput[]) => {
    if (files.length === 0) return
    try {
      const result = await api.invoke('attachments:add', { chatId, files })
      setPending((prev) => [...prev, ...result.attachments])
      setNotice(result.errors.length ? result.errors.join('\n') : null)
    } catch (e) {
      setNotice(cleanError(e))
    }
  }

  const addFileObjects = async (list: FileList | File[]) => {
    const inputs: AttachmentInput[] = []
    for (const file of Array.from(list)) {
      const path = api.getPathForFile(file)
      if (path) inputs.push({ source: 'path', path })
      else
        inputs.push({
          source: 'data',
          name: file.name || 'eingefuegt.png',
          mimeType: file.type,
          base64: await toBase64(file),
        })
    }
    await addFiles(inputs)
  }

  const pickFiles = async () => {
    const paths = await api.invoke('dialog:open-files')
    await addFiles(paths.map((path) => ({ source: 'path' as const, path })))
  }

  const send = async () => {
    const prompt = draft.trim()
    if ((!prompt && pending.length === 0) || running || live) return
    const attachments = pending
    setDraft('')
    setPending([])
    setNotice(null)
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        chatId,
        role: 'user',
        text: prompt,
        attachments,
        parts: [],
        error: null,
        costUsd: null,
        durationMs: null,
        createdAt: Date.now(),
      },
    ])
    setLive(EMPTY_REPLY)
    const { accepted } = await api.invoke('agent:send', { chatId, prompt, attachments })
    if (!accepted) {
      setLive(null)
      setNotice('Die Nachricht konnte nicht gesendet werden (Chat beschäftigt?).')
    }
  }

  const provider = settings.activeProvider
  const setModel = async (model: string) =>
    props.onSettingsChange(
      await api.invoke('settings:update', { models: { ...settings.models, [provider]: model } }),
    )

  const setEffort = async (effort: Effort) =>
    props.onSettingsChange(await api.invoke('settings:update', { effort }))

  const toggleCowork = async () =>
    props.onSettingsChange(
      await api.invoke('settings:update', { coworkEnabled: !settings.coworkEnabled }),
    )
  const cowork = settings.coworkEnabled

  const setPermissionMode = async (mode: AgentPermissionMode) => {
    await api.invoke('chats:set-permission-mode', { chatId, mode })
    setChat((c) => (c ? { ...c, permissionMode: mode } : c))
  }

  const isCode = chat?.mode === 'code' && chat.projectPath !== null
  // Coding chats open with the project panel unless the user chose otherwise.
  const activePanel = panel ?? (isCode ? 'project' : null)

  const attachOutput = async (path: string) => {
    await addFiles([{ source: 'path', path }])
  }

  return (
    <div className="flex h-full min-w-0 flex-1">
      <div
        className="relative flex h-full min-w-0 flex-1 flex-col"
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void addFileObjects(e.dataTransfer.files)
        }}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-blue-500 bg-blue-500/10 text-blue-600">
            Dateien hier ablegen
          </div>
        )}

        <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
          <span className="text-sm text-zinc-500">{PROVIDER_LABELS[provider]}</span>
          <button
            type="button"
            onClick={() => void toggleCowork()}
            disabled={running}
            title={
              cowork
                ? 'Cowork an: Jev wählt pro Anfrage Rolle, Modell und Effort; Subagents übernehmen Teilaufgaben. Rollen unter Einstellungen → Cowork.'
                : 'Cowork einschalten: Jev verteilt Anfragen auf deine Rollen (Modelle + Effort) und Subagents.'
            }
            className={`flex items-center gap-1 rounded-md border px-2 py-1 text-sm disabled:opacity-50 ${
              cowork
                ? 'border-violet-500 bg-violet-500/15 text-violet-700 dark:text-violet-300'
                : 'border-zinc-300 text-zinc-500 dark:border-zinc-700'
            }`}
          >
            <Users size={14} /> Cowork
          </button>
          {cowork ? (
            <span className="text-xs text-zinc-500">
              {settings.coworkRoles.map((r) => r.name).join(' · ')}
            </span>
          ) : (
            <ModelPicker
              key={provider}
              provider={provider}
              value={settings.models[provider]}
              onChange={(m) => void setModel(m)}
              compact
            />
          )}
          <select
            value={provider === 'ollama' ? 'default' : settings.effort}
            hidden={cowork}
            disabled={provider === 'ollama' || running}
            title={
              provider === 'ollama'
                ? 'Effort gibt es nur bei Claude-Modellen (Anthropic, OpenRouter).'
                : 'Effort: Wie gründlich das Modell nachdenkt. Höher = genauer, aber langsamer und teurer. Modelle ohne Effort-Unterstützung ignorieren die Einstellung.'
            }
            aria-label="Effort"
            onChange={(e) => void setEffort(EffortSchema.parse(e.target.value))}
            className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
          >
            {EffortSchema.options.map((level) => (
              <option key={level} value={level}>
                Effort: {EFFORT_LABELS[level]}
              </option>
            ))}
          </select>
          {isCode && chat && (
            <>
              <span
                className="flex min-w-0 items-center gap-1 truncate text-xs text-zinc-500"
                title={chat.projectPath ?? ''}
              >
                <FolderCode size={14} className="shrink-0" />
                <span className="truncate">{chat.projectPath}</span>
              </span>
              <select
                value={chat.permissionMode}
                title="Freigaben für den Agenten"
                onChange={(e) =>
                  void setPermissionMode(AgentPermissionModeSchema.parse(e.target.value))
                }
                className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
              >
                {AgentPermissionModeSchema.options.map((mode) => (
                  <option key={mode} value={mode}>
                    {PERMISSION_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
            </>
          )}
          <span className="ml-auto" />
          <ContextMeter chatId={chatId} />
          <span className="text-xs text-zinc-400">
            {totalCost > 0 ? `Kosten: $${totalCost.toFixed(4)}` : ''}
          </span>
          {isCode && (
            <PanelToggle
              label="Projekt-Panel"
              active={activePanel === 'project'}
              onClick={() => setPanel(activePanel === 'project' ? null : 'project')}
            >
              <PanelRight size={18} />
            </PanelToggle>
          )}
          <PanelToggle
            label="Ergebnisse (Bilder, 3D, Dateien)"
            active={activePanel === 'outputs'}
            onClick={() => setPanel(activePanel === 'outputs' ? null : 'outputs')}
          >
            <Images size={18} />
          </PanelToggle>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-5 p-6">
            {messages.length === 0 && !live && (
              <p className="pt-24 text-center text-zinc-400">
                {isCode
                  ? 'Was soll ich in diesem Projekt tun? Der Agent kann Dateien lesen, ändern und Befehle ausführen.'
                  : 'Womit kann ich helfen? Dateien per Drag & Drop, Strg+V oder 📎 anhängen.'}
              </p>
            )}
            {messages.map((m) =>
              m.role === 'user' ? (
                <UserBubble key={m.id} message={m} />
              ) : (
                <AssistantBlock
                  key={m.id}
                  parts={m.parts}
                  onUseAsInput={(path) => void attachOutput(path)}
                  error={m.error}
                  meta={
                    m.durationMs !== null
                      ? `${(m.durationMs / 1000).toFixed(1)} s · $${(m.costUsd ?? 0).toFixed(4)}`
                      : null
                  }
                />
              ),
            )}
            {live && <AssistantBlock parts={live.parts} error={live.error} meta={null} pending />}
            {permissions.map((request) => (
              <PermissionPrompt key={request.requestId} request={request} />
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
          <div className="mx-auto max-w-3xl space-y-2">
            {pending.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {pending.map((a) => (
                  <AttachmentChip
                    key={a.id}
                    attachment={a}
                    onRemove={() => setPending((p) => p.filter((x) => x.id !== a.id))}
                  />
                ))}
              </div>
            )}
            {notice && <p className="text-sm whitespace-pre-wrap text-amber-600">{notice}</p>}
            <div className="flex items-end gap-2">
              <IconButton label="Datei anhängen" variant="ghost" onClick={() => void pickFiles()}>
                <Paperclip size={18} />
              </IconButton>
              <textarea
                value={draft}
                rows={Math.min(8, Math.max(1, draft.split('\n').length))}
                placeholder="Nachricht … (Enter = senden, Shift+Enter = neue Zeile)"
                onChange={(e) => setDraft(e.target.value)}
                onPaste={(e) => {
                  if (e.clipboardData.files.length > 0) {
                    e.preventDefault()
                    void addFileObjects(e.clipboardData.files)
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                className="min-h-10 flex-1 resize-none rounded-lg border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
              />
              {running ? (
                <IconButton
                  label="Stoppen"
                  onClick={() => void api.invoke('agent:cancel', { chatId })}
                >
                  <Square size={18} />
                </IconButton>
              ) : (
                <IconButton
                  label="Senden"
                  onClick={() => void send()}
                  disabled={!draft.trim() && pending.length === 0}
                >
                  <Send size={18} />
                </IconButton>
              )}
            </div>
          </div>
        </div>
      </div>
      {activePanel === 'project' && chat?.projectPath && (
        <ProjectPanel projectPath={chat.projectPath} />
      )}
      {activePanel === 'outputs' && (
        <OutputsPanel
          chatId={chatId}
          refreshKey={outputsVersion}
          onUseAsInput={(path) => void attachOutput(path)}
        />
      )}
    </div>
  )
}

function PanelToggle(props: {
  label: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      onClick={props.onClick}
      className={`rounded-md p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
        props.active ? 'text-blue-600' : 'text-zinc-500'
      }`}
    >
      {props.children}
    </button>
  )
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error('Datei konnte nicht gelesen werden'))
    reader.readAsDataURL(file)
  })
}

function UserBubble({ message }: { message: ChatMessage }) {
  return (
    <div className="flex flex-col items-end gap-2">
      {message.attachments.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {message.attachments.map((a) => (
            <AttachmentChip key={a.id} attachment={a} />
          ))}
        </div>
      )}
      {message.text && (
        <div className="max-w-[85%] rounded-2xl bg-blue-600 px-4 py-2 whitespace-pre-wrap text-white">
          {message.text}
        </div>
      )}
    </div>
  )
}

function AssistantBlock(props: {
  parts: MessagePart[]
  onUseAsInput?: (path: string) => void
  error: string | null
  meta: string | null
  pending?: boolean
}) {
  const hasContent = props.parts.length > 0
  return (
    <div className="space-y-2">
      {props.parts.map((part, i) =>
        part.type === 'text' ? (
          <div key={i} className="prose-chat">
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {part.text}
            </Markdown>
          </div>
        ) : part.type === 'tool' ? (
          <ToolCard key={part.call.id} call={part.call} running={props.pending === true} />
        ) : part.type === 'route' ? (
          <RouteBadge key={i} route={part.route} />
        ) : (
          <InlineMedia
            key={i}
            path={part.file.path}
            name={part.file.name}
            kind={part.file.kind}
            mimeType={part.file.mimeType}
            {...(props.onUseAsInput ? { onUseAsInput: props.onUseAsInput } : {})}
          />
        ),
      )}
      {!hasContent && props.pending && !props.error && (
        <span className="animate-pulse text-zinc-400">…</span>
      )}
      {props.error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {cleanError(props.error)}
        </div>
      )}
      {props.meta && <div className="text-xs text-zinc-400">{props.meta}</div>}
    </div>
  )
}

function AttachmentChip(props: { attachment: Attachment; onRemove?: () => void }) {
  const a = props.attachment
  const icon =
    a.kind === 'pdf' || a.kind === 'text' ? (
      <FileText size={16} />
    ) : a.kind === 'model3d' ? (
      <Box size={16} />
    ) : (
      <FileIcon size={16} />
    )
  return (
    <div className="relative flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-1.5 pr-3 text-xs dark:border-zinc-700 dark:bg-zinc-900">
      {a.kind === 'image' ? (
        <img src={fileUrl(a.path)} alt={a.name} className="h-10 w-10 rounded object-cover" />
      ) : (
        <span className="flex h-10 w-10 items-center justify-center rounded bg-zinc-200 dark:bg-zinc-800">
          {icon}
        </span>
      )}
      <div className="max-w-40">
        <div className="truncate font-medium">{a.name}</div>
        <div className="text-zinc-500">{formatSize(a.size)}</div>
      </div>
      {props.onRemove && (
        <button
          type="button"
          title="Entfernen"
          onClick={props.onRemove}
          className="absolute -top-1.5 -right-1.5 rounded-full bg-zinc-700 p-0.5 text-white"
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function IconButton(props: {
  label: string
  onClick: () => void
  disabled?: boolean
  variant?: 'primary' | 'ghost'
  children: React.ReactNode
}) {
  const style =
    props.variant === 'ghost'
      ? 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
      : 'bg-blue-600 text-white'
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg disabled:opacity-40 ${style}`}
    >
      {props.children}
    </button>
  )
}
