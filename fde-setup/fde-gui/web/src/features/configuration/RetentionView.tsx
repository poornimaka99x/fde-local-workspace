import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, apiSend } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { ErrorState } from '../../components/States'

interface RetentionSettings {
  schemaVersion: 1
  enabled: boolean
  completedRunDays: number
}

interface RetentionResponse {
  settings: RetentionSettings
  warning?: string | null
  sweep?: {
    deletedRunIds: string[]
    skippedRunIds: string[]
    failures: Array<{ runId: string; message: string }>
  }
}

export function RetentionView(): JSX.Element {
  const current = useApi<RetentionResponse>('/api/configuration/retention')
  const [enabled, setEnabled] = useState(true)
  const [days, setDays] = useState(5)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!current.data) return
    setEnabled(current.data.settings.enabled)
    setDays(current.data.settings.completedRunDays)
  }, [current.data])

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const result = await apiSend<RetentionResponse>(
        '/api/configuration/retention', 'PUT', { enabled, completedRunDays: days },
      )
      const deleted = result.sweep?.deletedRunIds.length ?? 0
      const failures = result.sweep?.failures.length ?? 0
      setNotice(result.warning ?? (
        `Saved. ${deleted} completed run${deleted === 1 ? '' : 's'} moved to recoverable trash` +
        `${failures > 0 ? `; ${failures} could not be cleaned up` : ''}.`
      ))
    } catch (cause) {
      setError(cause instanceof ApiError
        ? cause
        : new ApiError(0, 'network', 'Could not save retention settings.'))
    } finally {
      setSaving(false)
    }
  }

  if (current.loading && !current.data) return <div className="card muted">Loading retention settings…</div>
  if (current.error && !current.data) return <ErrorState error={current.error} />

  return <section>
    <h2>Conversation retention</h2>
    <p className="lede">
      Completed governed-run conversations are moved to recoverable trash after the configured
      number of days. Active, incomplete, and awaiting-approval runs are never selected.
    </p>
    {error ? <ErrorState error={error} /> : null}
    {notice ? <p className="banner ok" role="status">{notice}</p> : null}
    <form className="card form-grid" onSubmit={(event) => void save(event)}>
      <label className="check-row">
        <input type="checkbox" checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)} />
        <span><strong>Automatically clean up completed conversations</strong><br />
          <span className="muted">Cleanup runs when FLOW starts, hourly while it is open, and after this setting is saved.</span>
        </span>
      </label>
      <label>
        <span>Keep completed conversations for</span>
        <span className="stack">
          <input type="number" min={1} max={3650} value={days} disabled={!enabled}
            onChange={(event) => setDays(Number(event.target.value))} />
          <span>days</span>
        </span>
      </label>
      <p className="muted">
        The default is 5 days. Cleanup uses the controller’s deletion path, so the complete run,
        artifacts, evidence, and transcript remain recoverable from <code>runs/.trash</code>.
      </p>
      <div><button className="action primary" type="submit" disabled={saving || days < 1 || days > 3650}>
        {saving ? 'Saving…' : 'Save retention'}
      </button></div>
    </form>
  </section>
}
