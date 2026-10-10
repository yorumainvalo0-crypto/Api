import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/schemas/updates'
import { api } from './api'

/** Live updater state: the current value plus every change pushed by the main process. */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    void api.invoke('updates:status').then((s) => {
      if (!cancelled) setStatus((current) => current ?? s)
    })
    const off = api.on('updates:changed', setStatus)
    return () => {
      cancelled = true
      off()
    }
  }, [])
  return status
}
