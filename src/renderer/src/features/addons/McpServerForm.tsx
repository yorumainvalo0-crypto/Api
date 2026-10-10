import { useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { AddonNameSchema, McpServerEntrySchema } from '@shared/schemas/addons'
import type { McpServerEntry, McpServerView } from '@shared/schemas/addons'
import { api } from '../../lib/api'
import { cleanError } from '../../components/ModelPicker'
import { Modal } from './Modal'
import { KeyValueEditor, recordToRows, rowsToRecord, type KeyValueRow } from './KeyValueEditor'
import { ErrorText } from './ui'
import { btnCls, btnPrimaryCls, inputCls } from './styles'

type TransportType = 'stdio' | 'http'

/** Add or edit an MCP server by hand. `initial` is set when editing an existing server. */
export function McpServerForm(props: {
  initial: McpServerView | null
  onSaved: () => void
  onClose: () => void
}) {
  const { initial } = props
  const editing = initial !== null
  const stdio = initial?.transport.type === 'stdio' ? initial.transport : null
  const http = initial?.transport.type === 'http' ? initial.transport : null
  const secretKeys = initial?.secretKeys ?? []

  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [type, setType] = useState<TransportType>(initial?.transport.type ?? 'stdio')
  const [command, setCommand] = useState(stdio?.command ?? '')
  const [args, setArgs] = useState((stdio?.args ?? []).join('\n'))
  const [envRows, setEnvRows] = useState<KeyValueRow[]>(() =>
    recordToRows(stdio?.env ?? {}, stdio ? secretKeys : []),
  )
  const [url, setUrl] = useState(http?.url ?? '')
  const [headerRows, setHeaderRows] = useState<KeyValueRow[]>(() =>
    recordToRows(http?.headers ?? {}, http ? secretKeys : []),
  )
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nameCheck = name ? AddonNameSchema.safeParse(name) : null
  const nameError = nameCheck && !nameCheck.success ? nameCheck.error.issues[0]?.message : null

  const save = () => {
    const entry = {
      name: name.trim(),
      enabled,
      description: description.trim(),
      source: initial?.source ?? 'manual',
      ...(initial?.registryName !== undefined ? { registryName: initial.registryName } : {}),
      transport:
        type === 'stdio'
          ? {
              type: 'stdio' as const,
              command: command.trim(),
              args: args
                .split('\n')
                .map((l) => l.replace(/\r$/, ''))
                .filter((l) => l.trim() !== ''),
              env: rowsToRecord(envRows),
            }
          : { type: 'http' as const, url: url.trim(), headers: rowsToRecord(headerRows) },
    }
    const parsed = McpServerEntrySchema.safeParse(entry)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue?.path.join('.') ?? ''
      setError(`${where ? `${where}: ` : ''}${issue?.message ?? 'Ungültige Eingabe'}`)
      return
    }
    const value: McpServerEntry = parsed.data
    setError(null)
    setSaving(true)
    api.invoke('addons:mcp-save', value).then(
      () => {
        setSaving(false)
        props.onSaved()
      },
      (e: unknown) => {
        setSaving(false)
        setError(cleanError(e))
      },
    )
  }

  return (
    <Modal
      wide
      title={editing ? `MCP-Server bearbeiten: ${initial.name}` : 'MCP-Server hinzufügen'}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className={btnCls} onClick={props.onClose}>
            Abbrechen
          </button>
          <button type="button" className={btnPrimaryCls} disabled={saving} onClick={save}>
            {saving && <Loader2 size={14} className="animate-spin" />}
            Speichern
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" hint="Buchstaben, Zahlen, Punkt, Binde- und Unterstrich">
          <input
            value={name}
            disabled={editing}
            placeholder="mein-server"
            onChange={(e) => setName(e.target.value)}
            className={inputCls}
          />
          {nameError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{nameError}</p>}
        </Field>

        <Field label="Beschreibung">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={inputCls}
          />
        </Field>

        <fieldset className="flex gap-4 text-sm">
          <legend className="mb-1 text-sm font-medium">Transport</legend>
          {(['stdio', 'http'] as const).map((t) => (
            <label key={t} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="mcp-transport"
                checked={type === t}
                onChange={() => setType(t)}
              />
              {t === 'stdio' ? 'stdio (lokaler Prozess)' : 'HTTP (Remote)'}
            </label>
          ))}
        </fieldset>

        {type === 'stdio' ? (
          <>
            <Field label="Befehl">
              <input
                value={command}
                placeholder="npx"
                onChange={(e) => setCommand(e.target.value)}
                className={`${inputCls} font-mono`}
              />
            </Field>
            <Field label="Argumente" hint="ein Argument pro Zeile">
              <textarea
                value={args}
                rows={4}
                placeholder={'-y\n@scope/server-name'}
                onChange={(e) => setArgs(e.target.value)}
                className={`${inputCls} font-mono`}
              />
            </Field>
            <Field label="Umgebungsvariablen" hint="Werte werden verschlüsselt gespeichert">
              <KeyValueEditor
                rows={envRows}
                onChange={setEnvRows}
                keyPlaceholder="NAME"
                valuePlaceholder="Wert"
                addLabel="Variable hinzufügen"
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="URL">
              <input
                value={url}
                placeholder="https://example.com/mcp"
                onChange={(e) => setUrl(e.target.value)}
                className={`${inputCls} font-mono`}
              />
            </Field>
            <Field label="Header" hint="Werte werden verschlüsselt gespeichert">
              <KeyValueEditor
                rows={headerRows}
                onChange={setHeaderRows}
                keyPlaceholder="Authorization"
                valuePlaceholder="Wert"
                addLabel="Header hinzufügen"
              />
            </Field>
          </>
        )}

        {editing && secretKeys.length > 0 && (
          <p className="text-xs text-zinc-500">
            Gespeicherte Werte bleiben erhalten, solange das Feld leer bleibt.
          </p>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Aktiviert
        </label>

        {error && <ErrorText>{error}</ErrorText>}
      </div>
    </Modal>
  )
}

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-sm font-medium">
        {props.label}
        {props.hint && <span className="ml-2 text-xs font-normal text-zinc-500">{props.hint}</span>}
      </div>
      {props.children}
    </div>
  )
}
