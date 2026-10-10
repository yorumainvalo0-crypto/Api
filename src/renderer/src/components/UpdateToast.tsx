import { useState } from 'react'
import { Download, X } from 'lucide-react'
import { api } from '../lib/api'
import { useUpdateStatus } from '../lib/use-update-status'

/** App-wide notice when an update finished downloading (or failed while downloading). */
export function UpdateToast(props: { onOpenSettings: () => void }) {
  const status = useUpdateStatus()
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (!status || (status.state !== 'downloaded' && status.state !== 'downloading')) return null
  const key = `${status.state}:${status.version ?? ''}`
  if (dismissed === key) return null

  return (
    <div className="fixed right-4 bottom-4 z-50 w-80 rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
      <div className="flex items-start gap-2">
        <Download size={16} className="mt-0.5 shrink-0 text-blue-600" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="font-medium">
            {status.state === 'downloaded'
              ? `Update ${status.version ?? ''} ist bereit`
              : `Update ${status.version ?? ''} wird geladen`}
          </div>
          {status.state === 'downloading' ? (
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
              <div
                className="h-full bg-blue-600 transition-all"
                style={{ width: `${status.percent ?? 0}%` }}
              />
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void api.invoke('updates:install')}
                className="rounded-md bg-blue-600 px-3 py-1 text-white"
              >
                Jetzt neu starten
              </button>
              <button
                type="button"
                onClick={() => setDismissed(key)}
                className="rounded-md border border-zinc-300 px-3 py-1 dark:border-zinc-700"
              >
                Später
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={props.onOpenSettings}
            className="text-xs text-zinc-500 underline"
          >
            Details in den Einstellungen
          </button>
        </div>
        <button
          type="button"
          aria-label="Schließen"
          onClick={() => setDismissed(key)}
          className="text-zinc-400 hover:text-zinc-600"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
