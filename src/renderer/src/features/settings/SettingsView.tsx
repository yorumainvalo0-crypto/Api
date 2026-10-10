import { useEffect, useState } from 'react'
import {
  PROVIDER_LABELS,
  ProviderIdSchema,
  type ProviderId,
  type SecretStatus,
  type Settings,
} from '@shared/schemas/settings'
import { api } from '../../lib/api'
import { useUpdateStatus } from '../../lib/use-update-status'
import { ModelPicker, cleanError } from '../../components/ModelPicker'
import { ImageGenerationSection } from './ImageGenerationSection'
import { LocalServicesSection } from './LocalServicesSection'
import { OcrSection } from './OcrSection'
import { JevSection } from './JevSection'

const PROVIDERS = ProviderIdSchema.options

export function SettingsView(props: { settings: Settings; onChange: (s: Settings) => void }) {
  const { settings, onChange } = props
  const [secrets, setSecrets] = useState<SecretStatus | null>(null)
  const [info, setInfo] = useState<string>('')
  const [dataDir, setDataDir] = useState('')

  useEffect(() => {
    void api.invoke('secrets:status').then(setSecrets)
    void api.invoke('app:info').then((i) => {
      setInfo(`v${i.version} · ${i.platform} · Agent SDK ${i.agentSdkVersion}`)
      setDataDir(i.dataDir)
    })
  }, [])

  const update = async (patch: Partial<Settings>) =>
    onChange(await api.invoke('settings:update', patch))

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-8 p-8">
        <header>
          <h1 className="text-2xl font-semibold">Einstellungen</h1>
          <p className="text-sm text-zinc-500">{info}</p>
        </header>

        <section className="space-y-3">
          <h2 className="font-medium">Aktiver Provider</h2>
          <div className="flex gap-2">
            {PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => void update({ activeProvider: p })}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  settings.activeProvider === p
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-zinc-300 dark:border-zinc-700'
                }`}
              >
                {PROVIDER_LABELS[p]}
              </button>
            ))}
          </div>
        </section>

        {PROVIDERS.map((p) => (
          <ProviderSection
            key={p}
            provider={p}
            settings={settings}
            hasKey={secrets?.[p] ?? false}
            encryptionAvailable={secrets?.encryptionAvailable ?? true}
            onSecrets={setSecrets}
            onUpdate={update}
          />
        ))}

        <JevSection
          settings={settings}
          secrets={secrets}
          onSecrets={setSecrets}
          onUpdate={update}
        />

        <section className="space-y-2">
          <h2 className="font-medium">Internet</h2>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.webAccess}
              onChange={(e) => void update({ webAccess: e.target.checked })}
            />
            Websuche und Seitenabruf für den Agenten erlauben (kostenlos, ohne API-Key)
          </label>
          <p className="text-xs text-zinc-500">
            Suche über DuckDuckGo bzw. Bing, Seiten werden lokal im eingebauten Chromium geladen.
          </p>
        </section>

        <LocalServicesSection settings={settings} update={update} />

        <ImageGenerationSection settings={settings} update={update} />

        <OcrSection settings={settings} update={update} />

        <section className="space-y-2">
          <h2 className="font-medium">Kostenlimit</h2>
          <label className="flex items-center gap-2 text-sm">
            Maximal
            <input
              type="number"
              min={0}
              step={0.1}
              defaultValue={settings.maxBudgetUsd}
              onBlur={(e) => {
                const value = Number(e.target.value)
                if (Number.isFinite(value) && value >= 0) void update({ maxBudgetUsd: value })
              }}
              className="w-24 rounded-md border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
            />
            US-Dollar pro Anfrage (0 = kein Limit)
          </label>
        </section>

        <UpdatesSection />

        <section className="space-y-2">
          <h2 className="font-medium">Daten</h2>
          <BackupButton />
          <p className="text-xs text-zinc-500">
            Speicherort: {dataDir || '…'} · Tastenkürzel: Strg+N neuer Chat, Strg+Umschalt+O Projekt
            öffnen, Strg+K Chats suchen, Strg+, Einstellungen
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-medium">Darstellung</h2>
          <select
            className="rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
            value={settings.theme}
            onChange={(e) => void update({ theme: e.target.value as Settings['theme'] })}
          >
            <option value="system">System</option>
            <option value="light">Hell</option>
            <option value="dark">Dunkel</option>
          </select>
        </section>
      </div>
    </div>
  )
}

function ProviderSection(props: {
  provider: ProviderId
  settings: Settings
  hasKey: boolean
  encryptionAvailable: boolean
  onSecrets: (s: SecretStatus) => void
  onUpdate: (patch: Partial<Settings>) => Promise<void>
}) {
  const { provider, settings, hasKey } = props
  const [keyDraft, setKeyDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [pickerKey, setPickerKey] = useState(0)

  const runTest = async () => {
    setTesting(true)
    setTest(await api.invoke('models:test', { provider }))
    setTesting(false)
    // Reload the model list with the new credentials.
    setPickerKey((k) => k + 1)
  }

  const saveKey = async () => {
    setError(null)
    try {
      props.onSecrets(await api.invoke('secrets:set', { provider, value: keyDraft }))
      setKeyDraft('')
      await runTest()
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const keyOptional = provider === 'ollama'

  return (
    <section className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="font-medium">{PROVIDER_LABELS[provider]}</h2>

      <label className="block space-y-1 text-sm">
        <span className="text-zinc-500">
          API-Key {keyOptional ? '(optional)' : ''} · {hasKey ? 'gespeichert ✓' : 'nicht gesetzt'}
        </span>
        <div className="flex gap-2">
          <input
            type="password"
            autoComplete="off"
            placeholder={hasKey ? '•••••••• (neu eingeben zum Ersetzen)' : 'Key einfügen'}
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700"
          />
          <button
            type="button"
            disabled={!keyDraft.trim() || !props.encryptionAvailable}
            onClick={() => void saveKey()}
            className="rounded-md bg-zinc-900 px-3 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Speichern
          </button>
          {hasKey && (
            <button
              type="button"
              onClick={() => void api.invoke('secrets:clear', { provider }).then(props.onSecrets)}
              className="rounded-md border border-zinc-300 px-3 dark:border-zinc-700"
            >
              Entfernen
            </button>
          )}
        </div>
      </label>

      <div className="space-y-1 text-sm">
        <span className="text-zinc-500">Modell</span>
        <ModelPicker
          key={pickerKey}
          provider={provider}
          value={settings.models[provider]}
          onChange={(model) =>
            void props.onUpdate({ models: { ...settings.models, [provider]: model } })
          }
        />
      </div>

      <div className="flex items-center gap-3 text-sm">
        <button
          type="button"
          disabled={testing}
          onClick={() => void runTest()}
          className="rounded-md border border-zinc-300 px-3 py-1 disabled:opacity-50 dark:border-zinc-700"
        >
          {testing ? 'Teste …' : 'Verbindung testen'}
        </button>
        {test && (
          <span className={test.ok ? 'text-green-600' : 'text-red-600'}>{test.message}</span>
        )}
      </div>

      {provider === 'ollama' && (
        <label className="block space-y-1 text-sm">
          <span className="text-zinc-500">Ollama-URL</span>
          <input
            defaultValue={settings.ollamaBaseUrl}
            onBlur={(e) =>
              void props
                .onUpdate({ ollamaBaseUrl: e.target.value.trim() })
                .then(() => setError(null))
                .catch(() => setError('Ungültige URL (Beispiel: http://localhost:11434)'))
            }
            className="w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700"
          />
        </label>
      )}

      {!props.encryptionAvailable && (
        <p className="text-sm text-amber-600">
          Sichere Verschlüsselung ist nicht verfügbar – Keys können nicht gespeichert werden.
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  )
}

function BackupButton() {
  const [message, setMessage] = useState<string | null>(null)
  const backup = async () => {
    try {
      const { savedTo } = await api.invoke('chats:backup')
      setMessage(savedTo ? `Gespeichert: ${savedTo}` : null)
    } catch (e) {
      setMessage(cleanError(e))
    }
  }
  return (
    <div className="flex items-center gap-3 text-sm">
      <button
        type="button"
        onClick={() => void backup()}
        className="rounded-md border border-zinc-300 px-3 py-1 dark:border-zinc-700"
      >
        Backup aller Chats speichern …
      </button>
      {message && <span className="text-xs text-zinc-500">{message}</span>}
    </div>
  )
}

function UpdatesSection() {
  const live = useUpdateStatus()
  const [checkError, setCheckError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const check = async () => {
    setChecking(true)
    setCheckError(null)
    try {
      await api.invoke('updates:check')
    } catch (e) {
      setCheckError(cleanError(e))
    } finally {
      setChecking(false)
    }
  }
  const busy = live?.state === 'checking' || live?.state === 'downloading'
  return (
    <section className="space-y-2">
      <h2 className="font-medium">Updates</h2>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button
          type="button"
          disabled={checking || busy}
          onClick={() => void check()}
          className="rounded-md border border-zinc-300 px-3 py-1 disabled:opacity-50 dark:border-zinc-700"
        >
          {checking ? 'Prüfe …' : 'Nach Updates suchen'}
        </button>
        {live?.state === 'downloaded' && (
          <button
            type="button"
            onClick={() => void api.invoke('updates:install')}
            className="rounded-md bg-blue-600 px-3 py-1 text-white"
          >
            Jetzt neu starten und installieren
          </button>
        )}
        {(checkError ?? live?.message) && (
          <span
            className={checkError || live?.state === 'error' ? 'text-red-600' : 'text-zinc-500'}
          >
            {checkError ?? live?.message}
          </span>
        )}
      </div>
      {live?.percent !== null && live?.percent !== undefined && live.state !== 'downloaded' && (
        <div className="h-2 max-w-md overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
          <div
            className="h-full bg-blue-600 transition-all"
            style={{ width: `${live.percent}%` }}
          />
        </div>
      )}
    </section>
  )
}
