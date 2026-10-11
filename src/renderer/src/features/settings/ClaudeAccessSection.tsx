import { useEffect, useState } from 'react'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import {
  AgentPermissionModeSchema,
  PERMISSION_MODE_HINTS,
  PERMISSION_MODE_LABELS,
  type SandboxStatus,
} from '@shared/schemas/permissions'
import type { Settings } from '@shared/schemas/settings'
import { api } from '../../lib/api'

/**
 * Permission mode and work folder confinement of Claude Code (terminal and coding chat), with an
 * honest status of what is protected on this computer.
 */
export function ClaudeAccessSection(props: {
  settings: Settings
  update: (patch: Partial<Settings>) => Promise<void>
}) {
  const { settings, update } = props
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.invoke('claude:sandbox-status').then((s) => {
      if (!cancelled) setSandbox(s)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const mode = settings.claudePermissionMode
  const confined = settings.confineToWorkFolder
  const autoWithOllama = mode === 'auto' && settings.activeProvider === 'ollama'

  return (
    <section className="space-y-3">
      <h2 className="font-medium">Claude Code: Berechtigungen &amp; Arbeitsordner</h2>
      <label className="flex flex-wrap items-center gap-2 text-sm">
        Freigabe-Modus
        <select
          value={mode}
          onChange={(e) =>
            void update({ claudePermissionMode: AgentPermissionModeSchema.parse(e.target.value) })
          }
          className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
        >
          {AgentPermissionModeSchema.options.map((m) => (
            <option key={m} value={m}>
              {PERMISSION_MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-zinc-500">
        {PERMISSION_MODE_HINTS[mode]} Gilt für „Claude Code starten“ bzw. <code>claude</code> in neu
        geöffneten Terminals und für neue Coding-Chats (dort oben im Chat änderbar).
      </p>
      {mode === 'auto' ? (
        <p className="text-xs text-zinc-500">
          Das Prüfmodell kostet zusätzliche Tokens. Anthropic: unterstützt. OpenRouter: Prüfung über
          anthropic/claude-sonnet-5. Ollama: kein Claude-Prüfmodell – dann gilt „
          {PERMISSION_MODE_LABELS.acceptEdits}“.
        </p>
      ) : null}
      {autoWithOllama ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Aktiver Provider ist Ollama: statt „Automatisch“ gilt „
          {PERMISSION_MODE_LABELS.acceptEdits}“ (Befehle werden nachgefragt).
        </p>
      ) : null}
      {mode === 'bypassPermissions' ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          „Alles erlauben“ führt jeden Befehl ohne Rückfrage aus
          {sandbox?.active && confined
            ? ' (in der Sandbox)'
            : ' – ohne Sandbox auch außerhalb des Ordners'}
          .
        </p>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={confined}
          onChange={(e) => void update({ confineToWorkFolder: e.target.checked })}
        />
        Nur im gewählten Arbeitsordner arbeiten
      </label>
      <p className="text-xs text-zinc-500">
        Arbeitsordner ist der Projektordner des Coding-Chats bzw. der mit „Ordner wählen …“
        geöffnete Ordner des Terminals. Lesen, Schreiben und Bearbeiten von Dateien außerhalb
        blockiert die App immer (auch bei „Alles erlauben“); Anhänge und Skills darf Claude nur
        lesen. Änderungen an .claude/settings*.json, .mcp.json und Git-Hooks fragt die App nach.
      </p>
      {confined && sandbox ? (
        <p
          className={`flex items-start gap-1.5 text-xs ${
            sandbox.active
              ? 'text-emerald-700 dark:text-emerald-400'
              : 'text-amber-600 dark:text-amber-400'
          }`}
        >
          {sandbox.active ? (
            <ShieldCheck size={14} className="mt-px shrink-0" />
          ) : (
            <ShieldAlert size={14} className="mt-px shrink-0" />
          )}
          <span>{sandbox.summary}</span>
        </p>
      ) : null}
      {!confined ? (
        <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <ShieldAlert size={14} className="mt-px shrink-0" />
          <span>
            Aus: Claude Code kann Dateien überall lesen und ändern, die dein Konto erreicht.
          </span>
        </p>
      ) : null}
    </section>
  )
}
