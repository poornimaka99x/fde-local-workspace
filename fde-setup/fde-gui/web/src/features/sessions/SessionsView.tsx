import { useState } from 'react'
import { Link } from '../../lib/router'
import { formatTime } from '../../lib/format'
import { useApi } from '../../lib/useApi'
import type { SessionListResponse } from '../../lib/types'
import { EmptyState, ErrorState, Loading } from '../../components/States'
import { ApiError, apiSend } from '../../lib/api'
import { announceChange } from '../../lib/changes'

export function SessionsView(): JSX.Element {
  const sessions = useApi<SessionListResponse>('/api/sessions', 10000)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<ApiError | null>(null)

  const deleteHistory = async (runId: string): Promise<void> => {
    if (!window.confirm(
      `Delete the console session history for ${runId}? The FDE run and its files will remain unchanged.`,
    )) return
    setDeleting(runId)
    setDeleteError(null)
    try {
      await apiSend(`/api/sessions/${encodeURIComponent(runId)}`, 'DELETE')
      announceChange()
      sessions.reload()
    } catch (cause) {
      setDeleteError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not delete this session history.'))
    } finally {
      setDeleting(null)
    }
  }

  if (sessions.error && sessions.data === null) return <ErrorState error={sessions.error} onRetry={sessions.reload} />
  if (sessions.data === null) return <Loading label="Loading sessions…" />

  const running = sessions.data.sessions.filter((session) => session.status === 'running')

  return (
    <>
      <h1>Console sessions</h1>
      <p className="lede">
        Every orchestrator session this console has started. Each one is a single{' '}
        <code>fde-start --resume</code> process, and only one per run.
      </p>

      {!sessions.data.available ? (
        <p className="banner warn">
          This installation has no terminal backend, so the console cannot start a session. Resume a
          run from a terminal with <code>fde-start --resume &lt;run-id&gt;</code>.
        </p>
      ) : null}
      {deleteError ? <ErrorState error={deleteError} /> : null}

      {sessions.data.sessions.length === 0 ? (
        <EmptyState title="Nothing running">
          Sessions started from this console appear here. A session started in your own terminal is
          not visible to the console — it belongs to that terminal.
        </EmptyState>
      ) : (
        <div className="card table-scroll">
          <table>
            <caption className="muted" style={{ captionSide: 'bottom', textAlign: 'left', paddingTop: 8 }}>
              {running.length} running, {sessions.data.sessions.length - running.length} finished
            </caption>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Status</th>
                <th scope="col">Started</th>
                <th scope="col">Viewers</th>
                <th scope="col">Working directory</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.data.sessions.map((session) => (
                <tr key={session.runId}>
                  <td>
                    {session.runId.startsWith('login:') ? (
                      <span className="mono">{session.runId}</span>
                    ) : (
                      <Link to={`/runs/${session.runId}`}>{session.runId}</Link>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${session.status === 'running' ? 'ok' : ''}`}>
                      {session.status}
                      {session.exitCode !== null ? ` (${session.exitCode})` : ''}
                    </span>
                  </td>
                  <td className="muted">{formatTime(session.startedAt)}</td>
                  <td>{session.attachedClients}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{session.cwd}</td>
                  <td>
                    <button
                      className="action danger"
                      type="button"
                      disabled={session.status === 'running' || deleting === session.runId}
                      onClick={() => void deleteHistory(session.runId)}
                    >
                      {deleting === session.runId
                        ? 'Deleting…'
                        : session.status === 'running' ? 'Stop to delete' : 'Delete history'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
