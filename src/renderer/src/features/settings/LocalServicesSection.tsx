import { useState } from 'react'
import { Radar } from 'lucide-react'
import type { IpcOutput } from '@shared/ipc'
import type { Settings } from '@shared/schemas/settings'
import { api } from '../../lib/api'
import { cleanError } from '../../components/ModelPicker'

type Found = IpcOutput<'local:discover'>

const button =
  'rounded-md border border-zinc-300 px-3 py-1 text-sm disabled:opacity-50 dark:border-zinc-700'

/** Finds Ollama/ComfyUI running on this PC (e.g. started via Pinokio) and applies their URLs. */
export function LocalServicesSection(props: {
  settings: Settings
  update: (patch: Partial<Settings>) => Promise<void>
}) {
  const { settings, update } = props
  const [found, setFound] = useState<Found | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const search = async () => {
    setSearching(true)
    setError(null)
    try {
      setFound(await api.invoke('local:discover'))
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setSearching(false)
    }
  }

  return (
    <section className="space-y-2">
      <h2 className="font-medium">Lokale KI-Dienste (Pinokio, Ollama, ComfyUI)</h2>
      <p className="text-xs text-zinc-500">
        Apps aus Pinokio (oder direkt installiert) laufen als lokale Server. Starte sie in Pinokio
        und lass sie hier automatisch finden.
      </p>
      <div className="flex items-center gap-3">
        <button type="button" disabled={searching} onClick={() => void search()} className={button}>
          <Radar size={14} className={`mr-1 inline ${searching ? 'animate-pulse' : ''}`} />
          {searching ? 'Suche …' : 'Automatisch finden'}
        </button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
      {found && (
        <div className="space-y-2 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
          {found.ollama.length === 0 && found.comfy.length === 0 && (
            <p className="text-zinc-500">
              Nichts gefunden. Läuft Ollama bzw. ComfyUI (in Pinokio auf „Start“ klicken)?
            </p>
          )}
          {found.ollama.map((s) => (
            <ServiceRow
              key={`o-${s.url}`}
              label={`Ollama ${s.version}`}
              url={s.url}
              active={settings.ollamaBaseUrl.replace(/\/+$/, '') === s.url}
              onUse={() => void update({ ollamaBaseUrl: s.url })}
            />
          ))}
          {found.comfy.map((s) => (
            <ServiceRow
              key={`c-${s.url}`}
              label={`ComfyUI ${s.version}`}
              url={s.url}
              active={settings.comfyUrl.replace(/\/+$/, '') === s.url}
              onUse={() => void update({ comfyUrl: s.url })}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function ServiceRow(props: { label: string; url: string; active: boolean; onUse: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="font-medium">{props.label}</span>
      <span className="text-zinc-500">{props.url}</span>
      {props.active ? (
        <span className="ml-auto text-xs text-green-600">wird verwendet ✓</span>
      ) : (
        <button type="button" onClick={props.onUse} className={`${button} ml-auto`}>
          Verwenden
        </button>
      )}
    </div>
  )
}
