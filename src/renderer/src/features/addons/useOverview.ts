import { useCallback, useEffect, useState } from 'react'
import type { AddonsOverview } from '@shared/schemas/addons'
import { api } from '../../lib/api'
import { cleanError } from '../../components/ModelPicker'

interface OverviewState {
  overview: AddonsOverview | null
  error: string | null
  loading: boolean
}

/** Loads `addons:overview` and exposes a `reload` that re-fetches it. */
export function useOverview(): OverviewState & { reload: () => void } {
  const [state, setState] = useState<OverviewState>({
    overview: null,
    error: null,
    loading: true,
  })
  const [token, setToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    api.invoke('addons:overview').then(
      (overview) => {
        if (!cancelled) setState({ overview, error: null, loading: false })
      },
      (e: unknown) => {
        if (!cancelled) setState((s) => ({ ...s, error: cleanError(e), loading: false }))
      },
    )
    return () => {
      cancelled = true
    }
  }, [token])

  const reload = useCallback(() => setToken((t) => t + 1), [])
  return { ...state, reload }
}
