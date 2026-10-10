import { useState } from 'react'
import { Eye, FolderInput, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import type { McpServerView } from '@shared/schemas/addons'
import { api } from '../../lib/api'
import { cleanError } from '../../components/ModelPicker'
import { ConfirmDialog, Modal } from './Modal'
import { McpServerForm } from './McpServerForm'
import { Badge, ErrorText, SectionHeader, Toggle } from './ui'
import type { useOverview } from './useOverview'
import { btnCls, btnDangerCls, btnSmCls, cardCls } from './styles'

type Kind = 'skill' | 'plugin' | 'mcp'

const KIND_LABEL: Record<Kind, string> = {
  skill: 'Skill',
  plugin: 'Plugin',
  mcp: 'MCP-Server',
}

type FormState = { server: McpServerView | null } | null

export function InstalledTab(props: { data: ReturnType<typeof useOverview> }) {
  const { overview, loading, error: loadError, reload } = props.data
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ kind: Kind; name: string } | null>(null)
  const [skillView, setSkillView] = useState<{
    name: string
    content: string | null
    error: string | null
  } | null>(null)
  const [form, setForm] = useState<FormState>(null)

  /** Runs an action, shows its error inline and refreshes the overview on success. */
  const run = (key: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(key)
    setError(null)
    setMessage(null)
    action().then(
      () => {
        setBusy(null)
        if (success) setMessage(success)
        reload()
      },
      (e: unknown) => {
        setBusy(null)
        setError(cleanError(e))
        reload()
      },
    )
  }

  const toggle = (kind: Kind, name: string, enabled: boolean) => {
    const key = `toggle:${kind}:${name}`
    if (kind === 'skill') run(key, () => api.invoke('addons:skill-toggle', { name, enabled }))
    else if (kind === 'plugin')
      run(key, () => api.invoke('addons:plugin-toggle', { name, enabled }))
    else run(key, () => api.invoke('addons:mcp-toggle', { name, enabled }))
  }

  const remove = (kind: Kind, name: string) => {
    const key = `remove:${kind}:${name}`
    const done = () => setConfirm(null)
    const wrap = (action: () => Promise<unknown>) =>
      run(
        key,
        () =>
          action().then(
            (r) => {
              done()
              return r
            },
            (e: unknown) => {
              done()
              throw e
            },
          ),
        `${KIND_LABEL[kind]} „${name}“ entfernt.`,
      )
    if (kind === 'skill') wrap(() => api.invoke('addons:skill-remove', { name }))
    else if (kind === 'plugin') wrap(() => api.invoke('addons:plugin-remove', { name }))
    else wrap(() => api.invoke('addons:mcp-remove', { name }))
  }

  const viewSkill = (name: string) => {
    setSkillView({ name, content: null, error: null })
    api.invoke('addons:skill-read', { name }).then(
      (r) => setSkillView({ name, content: r.content, error: null }),
      (e: unknown) => setSkillView({ name, content: null, error: cleanError(e) }),
    )
  }

  const importFolder = () => {
    setBusy('import')
    setError(null)
    setMessage(null)
    api.invoke('addons:install-folder').then(
      (r) => {
        setBusy(null)
        if (r.installed) setMessage(`„${r.installed}“ installiert.`)
        reload()
      },
      (e: unknown) => {
        setBusy(null)
        setError(cleanError(e))
      },
    )
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={btnCls}
          disabled={busy === 'import'}
          onClick={importFolder}
        >
          {busy === 'import' ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <FolderInput size={14} />
          )}
          Ordner importieren …
        </button>
        <button type="button" className={btnCls} onClick={() => setForm({ server: null })}>
          <Plus size={14} />
          MCP-Server manuell hinzufügen
        </button>
      </div>

      {message && <p className="text-sm text-emerald-600 dark:text-emerald-400">{message}</p>}
      {error && <ErrorText>{error}</ErrorText>}
      {loadError && <ErrorText>{loadError}</ErrorText>}
      {loading && !overview && (
        <p className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 size={14} className="animate-spin" />
          Lade …
        </p>
      )}

      {overview && (
        <>
          <section className="space-y-3">
            <SectionHeader title="Skills" count={overview.skills.length} />
            {overview.skills.length === 0 && <Empty>Keine Skills installiert.</Empty>}
            {overview.skills.map((s) => (
              <div key={s.name} className={`${cardCls} flex items-start gap-3`}>
                <Toggle
                  checked={s.enabled}
                  label={s.enabled ? 'Deaktivieren' : 'Aktivieren'}
                  disabled={busy !== null}
                  onChange={(v) => toggle('skill', s.name, v)}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{s.name}</div>
                  <p className="text-sm break-words text-zinc-500">{s.description}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" className={btnSmCls} onClick={() => viewSkill(s.name)}>
                    <Eye size={12} />
                    Ansehen
                  </button>
                  <button
                    type="button"
                    className={btnDangerCls}
                    disabled={busy !== null}
                    onClick={() => setConfirm({ kind: 'skill', name: s.name })}
                  >
                    <Trash2 size={12} />
                    Entfernen
                  </button>
                </div>
              </div>
            ))}
          </section>

          <section className="space-y-3">
            <SectionHeader title="Plugins" count={overview.plugins.length} />
            {overview.plugins.length === 0 && <Empty>Keine Plugins installiert.</Empty>}
            {overview.plugins.map((p) => (
              <div key={p.name} className={`${cardCls} flex items-start gap-3`}>
                <Toggle
                  checked={p.enabled}
                  label={p.enabled ? 'Deaktivieren' : 'Aktivieren'}
                  disabled={busy !== null}
                  onChange={(v) => toggle('plugin', p.name, v)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{p.name}</span>
                    {p.version && <Badge>v{p.version}</Badge>}
                  </div>
                  <p className="text-sm break-words text-zinc-500">{p.description}</p>
                </div>
                <button
                  type="button"
                  className={btnDangerCls}
                  disabled={busy !== null}
                  onClick={() => setConfirm({ kind: 'plugin', name: p.name })}
                >
                  <Trash2 size={12} />
                  Entfernen
                </button>
              </div>
            ))}
          </section>

          <section className="space-y-3">
            <SectionHeader title="MCP-Server" count={overview.mcpServers.length} />
            {overview.mcpServers.length === 0 && <Empty>Keine MCP-Server eingerichtet.</Empty>}
            {overview.mcpServers.map((m) => (
              <div key={m.name} className={`${cardCls} flex items-start gap-3`}>
                <Toggle
                  checked={m.enabled}
                  label={m.enabled ? 'Deaktivieren' : 'Aktivieren'}
                  disabled={busy !== null}
                  onChange={(v) => toggle('mcp', m.name, v)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{m.name}</span>
                    <Badge tone={m.source === 'registry' ? 'blue' : 'neutral'}>
                      {m.source === 'registry' ? 'Registry' : 'Manuell'}
                    </Badge>
                  </div>
                  {m.description && (
                    <p className="text-sm break-words text-zinc-500">{m.description}</p>
                  )}
                  <p className="mt-0.5 font-mono text-xs break-all text-zinc-500">
                    {transportSummary(m)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" className={btnSmCls} onClick={() => setForm({ server: m })}>
                    <Pencil size={12} />
                    Bearbeiten
                  </button>
                  <button
                    type="button"
                    className={btnDangerCls}
                    disabled={busy !== null}
                    onClick={() => setConfirm({ kind: 'mcp', name: m.name })}
                  >
                    <Trash2 size={12} />
                    Entfernen
                  </button>
                </div>
              </div>
            ))}
          </section>
        </>
      )}

      {confirm && (
        <ConfirmDialog
          title={`${KIND_LABEL[confirm.kind]} entfernen`}
          message={`„${confirm.name}“ wirklich entfernen?`}
          confirmLabel="Entfernen"
          busy={busy !== null}
          onCancel={() => setConfirm(null)}
          onConfirm={() => remove(confirm.kind, confirm.name)}
        />
      )}

      {skillView && (
        <Modal wide title={`Skill: ${skillView.name}`} onClose={() => setSkillView(null)}>
          {skillView.error && <ErrorText>{skillView.error}</ErrorText>}
          {!skillView.error && skillView.content === null && (
            <p className="flex items-center gap-2 text-sm text-zinc-500">
              <Loader2 size={14} className="animate-spin" />
              Lade …
            </p>
          )}
          {skillView.content !== null && (
            <pre className="text-xs break-words whitespace-pre-wrap">{skillView.content}</pre>
          )}
        </Modal>
      )}

      {form && (
        <McpServerForm
          // Remount per target so the form state starts fresh.
          key={form.server?.name ?? '__new__'}
          initial={form.server}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null)
            setMessage('MCP-Server gespeichert.')
            reload()
          }}
        />
      )}
    </div>
  )
}

function Empty(props: { children: string }) {
  return <p className="text-sm text-zinc-500">{props.children}</p>
}

function transportSummary(m: McpServerView): string {
  const t = m.transport
  if (t.type === 'stdio') return ['stdio', t.command, ...t.args].join(' ')
  return `http ${t.url}`
}
