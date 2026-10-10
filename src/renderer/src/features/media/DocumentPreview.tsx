import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Loader2 } from 'lucide-react'
import type { IpcOutput } from '@shared/ipc'
import { api } from '../../lib/api'
import { cleanError } from '../../components/ModelPicker'

/** Word/Excel/PowerPoint/OpenOffice preview: the converted text with tables, as the AI sees it. */
export function DocumentPreview(props: { path: string }) {
  const [doc, setDoc] = useState<IpcOutput<'documents:preview'> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.invoke('documents:preview', { path: props.path }).then(
      (result) => {
        if (!cancelled) setDoc(result)
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      },
    )
    return () => {
      cancelled = true
    }
  }, [props.path])

  if (error) return <p className="p-3 text-sm text-red-600">{error}</p>
  if (!doc) {
    return (
      <p className="flex items-center gap-2 p-3 text-xs text-zinc-500">
        <Loader2 size={12} className="animate-spin" /> Dokument wird gelesen …
      </p>
    )
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <p className="mb-3 text-xs text-zinc-500">
        {doc.summary}
        {doc.truncated ? ' · gekürzt' : ''}
      </p>
      <div className="prose-chat text-sm">
        <Markdown remarkPlugins={[remarkGfm]}>{doc.markdown}</Markdown>
      </div>
    </div>
  )
}
