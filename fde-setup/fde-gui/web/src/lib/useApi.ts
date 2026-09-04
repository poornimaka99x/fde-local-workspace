import { useCallback, useEffect, useState } from 'react'
import { ApiError, apiGet } from './api'
import { subscribeToChanges } from './changes'

export interface ApiState<T> {
  data: T | null
  error: ApiError | null
  loading: boolean
  reload: () => void
}

/** One fetch, one loading flag, one error, and a way to ask again. */
export function useApi<T>(path: string | null, pollMs = 0): ApiState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(path !== null)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((value) => value + 1), [])

  useEffect(() => {
    if (path === null) {
      setData(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    apiGet<T>(path)
      .then((result) => {
        if (cancelled) return
        setData(result)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'The console could not reach the local server.'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [path, nonce])

  useEffect(() => {
    if (path === null || pollMs <= 0) return
    // Skip the request while the tab is in the background; the next poll
    // after it becomes visible again picks up whatever changed meanwhile.
    const tick = (): void => {
      if (!document.hidden) reload()
    }
    const timer = window.setInterval(tick, pollMs)
    return () => window.clearInterval(timer)
  }, [path, pollMs, reload])

  // Someone else changed the run — a terminal, another tab, this console.
  useEffect(() => {
    if (path === null) return
    return subscribeToChanges(reload)
  }, [path, reload])

  return { data, error, loading, reload }
}
