import { useState } from 'react'
import { Scale } from 'lucide-react'
import type { SecretStatus, Settings } from '@shared/schemas/settings'
import { api } from '../../lib/api'
import { cleanError } from '../../components/ModelPicker'

const DEFAULT_MODEL = { typesafe: 'jev-latest', openrouter: '~typesafe/jev-latest' } as const

const input =
  'min-w-0 flex-1 rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700'

/** Settings for the Jev decision model (TypeSafe), offered as a tool to every chat model. */
export function JevSection(props: {
  settings: Settings
  secrets: SecretStatus | null
  onSecrets: (s: SecretStatus) => void
  onUpdate: (patch: Partial<Settings>) => Promise<void>
}) {
  const { settings, secrets } = props
  const [keyDraft, setKeyDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)

  const source = settings.jevSource
  const hasKey = source === 'typesafe' ? Boolean(secrets?.typesafe) : Boolean(secrets?.openrouter)
  const active = settings.jevEnabled && hasKey

  const runTest = async () => {
    setTesting(true)
    try {
      setTest(await api.invoke('jev:test'))
    } finally {
      setTesting(false)
    }
  }

  const saveKey = async () => {
    setError(null)
    try {
      props.onSecrets(await api.invoke('secrets:set', { provider: 'typesafe', value: keyDraft }))
      setKeyDraft('')
      await runTest()
    } catch (e) {
      setError(cleanError(e))
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="flex items-center gap-2 font-medium">
        <Scale size={16} /> Jev (TypeSafe) – typsichere Entscheidungen
      </h2>
      <p className="text-sm text-zinc-500">
        Jev beantwortet getypte Fragen blitzschnell mit kalibrierten Wahrscheinlichkeiten: Auswahl,
        Bewertung auf einer Skala und Ja/Nein. Das aktive KI-Modell (Anthropic, OpenRouter oder
        Ollama) bekommt Jev automatisch als Werkzeug, z. B. zum Einordnen, Bewerten oder Prüfen von
        Antworten.
      </p>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.jevEnabled}
          onChange={(e) => void props.onUpdate({ jevEnabled: e.target.checked })}
        />
        Jev dem aktiven Modell als Werkzeug anbieten
        <span className={active ? 'text-green-600' : 'text-zinc-400'}>
          {active ? '· aktiv' : hasKey ? '· aus' : '· Key fehlt'}
        </span>
      </label>

      <label className="block space-y-1 text-sm">
        <span className="text-zinc-500">Zugang</span>
        <select
          value={source}
          onChange={(e) => {
            setTest(null)
            void props.onUpdate({
              jevSource: e.target.value === 'openrouter' ? 'openrouter' : 'typesafe',
            })
          }}
          className="w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700"
        >
          <option value="typesafe">TypeSafe direkt (eigener API-Key)</option>
          <option value="openrouter">Über OpenRouter (dein OpenRouter-Key)</option>
        </select>
      </label>

      {source === 'typesafe' ? (
        <label className="block space-y-1 text-sm">
          <span className="text-zinc-500">
            TypeSafe-API-Key · {secrets?.typesafe ? 'gespeichert ✓' : 'nicht gesetzt'} ·{' '}
            <a href="https://console.typesafe.ai/keys" target="_blank" rel="noreferrer">
              Key erstellen
            </a>
          </span>
          <div className="flex gap-2">
            <input
              type="password"
              autoComplete="off"
              placeholder={
                secrets?.typesafe ? '•••••••• (neu eingeben zum Ersetzen)' : 'Key einfügen'
              }
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              className={input}
            />
            <button
              type="button"
              disabled={!keyDraft.trim() || secrets?.encryptionAvailable === false}
              onClick={() => void saveKey()}
              className="rounded-md bg-zinc-900 px-3 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Speichern
            </button>
            {secrets?.typesafe && (
              <button
                type="button"
                onClick={() =>
                  void api.invoke('secrets:clear', { provider: 'typesafe' }).then(props.onSecrets)
                }
                className="rounded-md border border-zinc-300 px-3 dark:border-zinc-700"
              >
                Entfernen
              </button>
            )}
          </div>
        </label>
      ) : (
        <p className="text-sm text-zinc-500">
          Nutzt deinen OpenRouter-Key ({secrets?.openrouter ? 'gespeichert ✓' : 'fehlt noch'}).
          Abgerechnet wird über dein OpenRouter-Guthaben.
        </p>
      )}

      <label className="block space-y-1 text-sm">
        <span className="text-zinc-500">Modell (leer = neuestes)</span>
        <input
          key={source}
          defaultValue={settings.jevModel}
          placeholder={DEFAULT_MODEL[source]}
          onBlur={(e) => void props.onUpdate({ jevModel: e.target.value.trim() })}
          className={`w-full ${input}`}
        />
      </label>

      <div className="flex items-center gap-3 text-sm">
        <button
          type="button"
          disabled={testing || !hasKey}
          onClick={() => void runTest()}
          className="rounded-md border border-zinc-300 px-3 py-1 disabled:opacity-50 dark:border-zinc-700"
        >
          {testing ? 'Teste …' : 'Verbindung testen'}
        </button>
        {test && (
          <span className={test.ok ? 'text-green-600' : 'text-red-600'}>{test.message}</span>
        )}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  )
}
