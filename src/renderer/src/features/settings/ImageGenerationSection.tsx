import { useEffect, useState } from 'react'
import { Box, Image as ImageIcon, Trash2, Upload } from 'lucide-react'
import type { Settings } from '@shared/schemas/settings'
import type { ModelInfo } from '@shared/schemas/models'
import type { ComfyStatus, ComfyWorkflowInfo, ComfyWorkflowKind } from '@shared/schemas/comfy'
import { api } from '../../lib/api'
import { ModelPicker, cleanError } from '../../components/ModelPicker'

const imageCapable = (m: ModelInfo) => m.outputModalities.includes('image')

const input =
  'rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700'
const button =
  'rounded-md border border-zinc-300 px-3 py-1 text-sm disabled:opacity-50 dark:border-zinc-700'

/** Image backend (OpenRouter or local ComfyUI) plus imported ComfyUI workflows for images and 3D. */
export function ImageGenerationSection(props: {
  settings: Settings
  update: (patch: Partial<Settings>) => Promise<void>
}) {
  const { settings, update } = props
  const [status, setStatus] = useState<ComfyStatus | null>(null)
  const [testing, setTesting] = useState(false)
  const [workflows, setWorkflows] = useState<ComfyWorkflowInfo[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.invoke('comfy:workflows').then((list) => {
      if (!cancelled) setWorkflows(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const test = async () => {
    setTesting(true)
    setStatus(await api.invoke('comfy:status'))
    setTesting(false)
  }

  const importWorkflow = async (kind: ComfyWorkflowKind) => {
    setError(null)
    const name = window.prompt(
      kind === '3d' ? 'Name des 3D-Workflows (z. B. „Hunyuan3D“):' : 'Name des Bild-Workflows:',
    )
    if (!name?.trim()) return
    try {
      const info = await api.invoke('comfy:workflow-import', { name: name.trim(), kind })
      if (info) setWorkflows(await api.invoke('comfy:workflows'))
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const remove = async (wf: ComfyWorkflowInfo) => {
    if (!window.confirm(`Workflow „${wf.name}“ entfernen?`)) return
    await api.invoke('comfy:workflow-remove', { id: wf.id })
    setWorkflows(await api.invoke('comfy:workflows'))
  }

  const imageWorkflows = workflows.filter((w) => w.kind === 'image')
  const models = status?.models ?? []
  const isComfy = settings.imageBackend === 'comfyui'

  return (
    <section className="space-y-3">
      <h2 className="font-medium">Bild- und 3D-Generierung</h2>
      <div className="flex gap-2 text-sm">
        {(['openrouter', 'comfyui'] as const).map((backend) => (
          <button
            key={backend}
            type="button"
            onClick={() => void update({ imageBackend: backend })}
            className={`rounded-md border px-3 py-1.5 ${
              settings.imageBackend === backend
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-zinc-300 dark:border-zinc-700'
            }`}
          >
            {backend === 'openrouter' ? 'OpenRouter (Cloud)' : 'ComfyUI (lokal, kostenlos)'}
          </button>
        ))}
      </div>

      {!isComfy ? (
        <div className="space-y-1">
          <p className="text-xs text-zinc-500">
            Benötigt den OpenRouter-Key. Kosten je nach Modell (siehe Preis in der Liste).
          </p>
          <ModelPicker
            provider="openrouter"
            value={settings.imageModel}
            onChange={(model) => void update({ imageModel: model })}
            filter={imageCapable}
          />
        </div>
      ) : (
        <div className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="text-xs text-zinc-500">
            ComfyUI muss auf diesem PC laufen (Desktop-App: Port 8000, Portable/Pinokio: meist
            8188). Bilder entstehen lokal auf deiner Grafikkarte – ohne Kosten. Erkannt werden
            Checkpoints und Einzeldatei-Modelle (Z-Image Turbo, Flux.1 dev/schnell, Qwen-Image).
          </p>
          <label className="block space-y-1 text-sm">
            <span className="text-zinc-500">ComfyUI-Adresse</span>
            <input
              defaultValue={settings.comfyUrl}
              onBlur={(e) =>
                void update({ comfyUrl: e.target.value.trim() }).catch(() =>
                  setError('Ungültige Adresse (Beispiel: http://127.0.0.1:8188)'),
                )
              }
              className={`${input} w-full`}
            />
          </label>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <button type="button" disabled={testing} onClick={() => void test()} className={button}>
              {testing ? 'Teste …' : 'Verbindung testen'}
            </button>
            {status && (
              <span className={status.ok ? 'text-green-600' : 'text-red-600'}>
                {status.message}
              </span>
            )}
          </div>
          {status && status.suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-zinc-500">ComfyUI gefunden unter:</span>
              {status.suggestions.map((url) => (
                <button
                  key={url}
                  type="button"
                  onClick={() => void update({ comfyUrl: url }).then(() => test())}
                  className={button}
                >
                  {url} verwenden
                </button>
              ))}
            </div>
          )}

          <label className="block space-y-1 text-sm">
            <span className="text-zinc-500">Bild-Workflow</span>
            <select
              value={settings.comfyImageWorkflow}
              onChange={(e) => void update({ comfyImageWorkflow: e.target.value })}
              className={`${input} w-full`}
            >
              <option value="">Eingebaut: Text → Bild (Modell unten)</option>
              {imageWorkflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>

          {!settings.comfyImageWorkflow && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <label className="space-y-1">
                <span className="text-zinc-500">Modell</span>
                <select
                  value={settings.comfyCheckpoint}
                  onChange={(e) => void update({ comfyCheckpoint: e.target.value })}
                  className={`${input} w-full`}
                >
                  <option value="">Bestes verfügbares</option>
                  {models.some((m) => m.kind === 'checkpoint') && (
                    <optgroup label="Checkpoints">
                      {models
                        .filter((m) => m.kind === 'checkpoint')
                        .map((m) => (
                          <option key={m.name} value={m.name}>
                            {m.name}
                          </option>
                        ))}
                    </optgroup>
                  )}
                  {models.some((m) => m.kind === 'diffusion') && (
                    <optgroup label="Einzeldatei-Modelle (diffusion_models)">
                      {models
                        .filter((m) => m.kind === 'diffusion')
                        .map((m) => (
                          <option
                            key={m.name}
                            value={m.name}
                            disabled={m.family === null || m.missing.length > 0}
                          >
                            {m.name} –{' '}
                            {m.family === null
                              ? 'Typ unbekannt, Workflow importieren'
                              : m.missing.length > 0
                                ? `${m.familyLabel}: fehlt ${m.missing.join(', ')}`
                                : m.familyLabel}
                          </option>
                        ))}
                    </optgroup>
                  )}
                  {settings.comfyCheckpoint &&
                    !models.some((m) => m.name === settings.comfyCheckpoint) && (
                      <option value={settings.comfyCheckpoint}>{settings.comfyCheckpoint}</option>
                    )}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-zinc-500">Auflösung (lange Seite)</span>
                <select
                  value={settings.comfyResolution}
                  onChange={(e) => void update({ comfyResolution: Number(e.target.value) })}
                  className={`${input} w-full`}
                >
                  <option value={512}>512 (SD 1.5)</option>
                  <option value={768}>768</option>
                  <option value={1024}>1024 (SDXL / Flux)</option>
                  <option value={1536}>1536</option>
                </select>
              </label>
            </div>
          )}
        </div>
      )}

      <div className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">Eigene ComfyUI-Workflows</h3>
          <button type="button" onClick={() => void importWorkflow('image')} className={button}>
            <Upload size={14} className="mr-1 inline" /> Bild-Workflow
          </button>
          <button type="button" onClick={() => void importWorkflow('3d')} className={button}>
            <Upload size={14} className="mr-1 inline" /> 3D-Workflow
          </button>
        </div>
        <p className="text-xs text-zinc-500">
          Einen funktionierenden Workflow in ComfyUI über „Workflow → Export (API)“ speichern und
          hier importieren – damit läuft jedes Modell. Prompt, Negativ-Prompt, Seed, Bildgröße und
          Eingabebild (LoadImage) werden automatisch erkannt. Wer es genau steuern will, trägt
          vorher selbst <code>{'{{prompt}}'}</code>, <code>{'{{negative}}'}</code>,{' '}
          <code>{'{{seed}}'}</code>, <code>{'{{width}}'}</code>/<code>{'{{height}}'}</code> oder{' '}
          <code>{'{{input_image}}'}</code> ein. 3D-Workflows (z. B. Hunyuan3D mit „Save GLB“) stehen
          dem Agenten als Werkzeug „generate_3d_model“ zur Verfügung.
        </p>
        {workflows.length === 0 ? (
          <p className="text-xs text-zinc-400">Noch keine Workflows importiert.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {workflows.map((w) => (
              <li key={w.id} className="flex items-center gap-2">
                {w.kind === '3d' ? <Box size={14} /> : <ImageIcon size={14} />}
                <span className="font-medium">{w.name}</span>
                <span className="truncate text-xs text-zinc-500">
                  {w.autoDetected ? 'automatisch erkannt: ' : ''}
                  {w.placeholders.map((p) => `{{${p}}}`).join(' ')}
                </span>
                <button
                  type="button"
                  title="Entfernen"
                  onClick={() => void remove(w)}
                  className="ml-auto text-zinc-500 hover:text-red-600"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  )
}
