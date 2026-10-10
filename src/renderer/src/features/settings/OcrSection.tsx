import { useEffect, useState } from 'react'
import { Download, PenLine, Trash2 } from 'lucide-react'
import type { IpcEventPayload, IpcOutput } from '@shared/ipc'
import type { Settings } from '@shared/schemas/settings'
import { api } from '../../lib/api'
import { cleanError } from '../../components/ModelPicker'

const MODELS = [
  { id: 'qwen3-vl:8b-instruct', label: 'Qwen3-VL 8B – beste Qualität (~6 GB, RTX 4060 ✓)' },
  { id: 'qwen3-vl:4b-instruct', label: 'Qwen3-VL 4B – schneller (~3 GB)' },
  { id: 'qwen2.5vl:7b', label: 'Qwen2.5-VL 7B (~6 GB)' },
]

const button =
  'rounded-md border border-zinc-300 px-3 py-1 text-sm disabled:opacity-50 dark:border-zinc-700'
const input =
  'rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700'

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/** Local handwriting/document OCR with an Ollama vision model that only uses the GPU on demand. */
export function OcrSection(props: {
  settings: Settings
  update: (patch: Partial<Settings>) => Promise<void>
}) {
  const { settings, update } = props
  const [status, setStatus] = useState<IpcOutput<'ocr:status'> | null>(null)
  const [progress, setProgress] = useState<IpcEventPayload<'ocr:progress'> | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    try {
      setStatus(await api.invoke('ocr:status'))
    } catch (e) {
      setError(cleanError(e))
    }
  }

  useEffect(() => {
    let cancelled = false
    void api.invoke('ocr:status').then((s) => {
      if (!cancelled) setStatus(s)
    })
    const off = api.on('ocr:progress', (p) => {
      setProgress(p)
      if (p.done) {
        if (p.error) setError(p.error)
        void api.invoke('ocr:status').then((s) => {
          if (!cancelled) setStatus(s)
        })
      }
    })
    return () => {
      cancelled = true
      off()
    }
  }, [settings.ocrModel, settings.ollamaBaseUrl, settings.ocrBaseUrl])

  const download = async () => {
    setError(null)
    setProgress({ status: 'Starte Download …', completed: 0, total: 0, done: false, error: null })
    await api.invoke('ocr:download')
  }

  const remove = async () => {
    if (!window.confirm(`Modell ${settings.ocrModel} von der Festplatte entfernen?`)) return
    try {
      await api.invoke('ocr:remove')
      await refresh()
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const downloading = progress !== null && !progress.done
  const percent =
    progress && progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : null

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 font-medium">
        <PenLine size={16} /> Handschrift-Erkennung (lokal auf deiner Grafikkarte)
      </h2>
      <p className="text-xs text-zinc-500">
        Ein Vision-Modell liest Handschrift, Scans und Fotos von Dokumenten – ohne Cloud. Es wird
        nur bei Nutzung auf die GPU geladen und danach automatisch wieder entladen. Benötigt Ollama
        (direkt installiert oder über Pinokio).
      </p>

      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-zinc-500">Modell</span>
          <select
            value={settings.ocrModel}
            onChange={(e) => void update({ ocrModel: e.target.value })}
            className={`${input} w-full`}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            {!MODELS.some((m) => m.id === settings.ocrModel) && (
              <option value={settings.ocrModel}>{settings.ocrModel}</option>
            )}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-zinc-500">GPU wieder freigeben nach</span>
          <select
            value={settings.ocrKeepAliveSec}
            onChange={(e) => void update({ ocrKeepAliveSec: Number(e.target.value) })}
            className={`${input} w-full`}
          >
            <option value={0}>sofort nach jeder Erkennung</option>
            <option value={60}>1 Minute (empfohlen)</option>
            <option value={300}>5 Minuten</option>
            <option value={1800}>30 Minuten</option>
          </select>
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className="text-zinc-500">Ollama-Adresse für OCR (leer = wie beim Chat)</span>
          <input
            defaultValue={settings.ocrBaseUrl}
            placeholder={settings.ollamaBaseUrl}
            onBlur={(e) =>
              void update({ ocrBaseUrl: e.target.value.trim() }).catch(() =>
                setError('Ungültige Adresse (Beispiel: http://127.0.0.1:11434)'),
              )
            }
            className={`${input} w-full`}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        {status?.installed ? (
          <>
            <span className="text-green-600">{status.message}</span>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.ocrEnabled}
                onChange={(e) => void update({ ocrEnabled: e.target.checked })}
              />
              Für den Agenten aktivieren
            </label>
            <button type="button" onClick={() => void remove()} className={button}>
              <Trash2 size={14} className="mr-1 inline" /> Entfernen
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={downloading || !status?.reachable}
              onClick={() => void download()}
              className={button}
            >
              <Download size={14} className="mr-1 inline" />
              {downloading ? 'Lädt …' : 'Modell herunterladen'}
            </button>
            {status && (
              <span className={status.reachable ? 'text-zinc-500' : 'text-amber-600'}>
                {status.message}
              </span>
            )}
            {status && !status.reachable && (
              <a
                href="https://ollama.com/download"
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 underline"
              >
                Ollama herunterladen
              </a>
            )}
          </>
        )}
        <button type="button" onClick={() => void refresh()} className={button}>
          Neu prüfen
        </button>
      </div>

      {downloading && progress && (
        <div className="space-y-1">
          <div className="h-2 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
            <div
              className="h-full bg-blue-600 transition-all"
              style={{ width: `${percent ?? 5}%` }}
            />
          </div>
          <p className="text-xs text-zinc-500">
            {progress.status}
            {progress.total > 0 &&
              ` – ${formatGb(progress.completed)} / ${formatGb(progress.total)} (${percent} %)`}
          </p>
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  )
}
