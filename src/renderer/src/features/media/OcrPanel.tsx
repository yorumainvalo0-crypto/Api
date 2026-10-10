import { useState } from 'react'
import { Copy, Loader2, PenLine, X } from 'lucide-react'
import { api } from '../../lib/api'
import { cleanError } from '../../components/ModelPicker'

/** "Text erkennen" for images: runs the local OCR model and shows the transcription. */
export function OcrButton(props: { onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      title="Handschrift/Text lokal erkennen"
      onClick={props.onClick}
      disabled={props.busy}
      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      {props.busy ? <Loader2 size={13} className="animate-spin" /> : <PenLine size={13} />}
      Text erkennen
    </button>
  )
}

export function useOcr(path: string) {
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      setText((await api.invoke('ocr:recognize', { path, mode: 'handwriting' })).text)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }
  const reset = () => {
    setText(null)
    setError(null)
  }
  return { busy, text, error, run, reset }
}

export function OcrResult(props: {
  text: string | null
  error: string | null
  onClose: () => void
}) {
  if (props.text === null && props.error === null) return null
  return (
    <div className="max-h-[40%] shrink-0 overflow-auto border-t border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-medium">Erkannter Text</span>
        {props.text && (
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(props.text ?? '')}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <Copy size={12} /> Kopieren
          </button>
        )}
        <button
          type="button"
          title="Schließen"
          onClick={props.onClose}
          className="ml-auto rounded p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <X size={14} />
        </button>
      </div>
      {props.error ? (
        <p className="text-red-600">{props.error}</p>
      ) : (
        <pre className="font-sans whitespace-pre-wrap">{props.text}</pre>
      )}
    </div>
  )
}
