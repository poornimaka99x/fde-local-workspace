import { Link } from '../../lib/router'
import { formatTime } from '../../lib/format'
import { useApi } from '../../lib/useApi'
import type { SessionListResponse } from '../../lib/types'
import { EmptyState, ErrorState, Loading } from '../../components/States'

export function SessionsView(): JSX.Element {
  const sessions = useApi<SessionListResponse>('/api/sessions', 10000)

  if (sessions.error) return <ErrorState error={sessions.error} onRetry={sessions.reload} />
  if (sessions.data === null) return <Loading label="Loading sessions…" />

  const running = sessions.data.sessions.filter((session) => session.status === 'running')

  return (
    <>
      <h1>Active sessions</h1>
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
              </tr>
            </thead>
            <tbody>
              {sessions.data.sessions.map((session) => (
                <tr key={session.runId}>
                  <td>
                    <Link to={`/runs/${session.runId}`}>{session.runId}</Link>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
