import { useState } from 'react'
import { Link } from '../../lib/router'
import { formatTime, stateTone } from '../../lib/format'
import { useApi } from '../../lib/useApi'
import type { ProjectDetailResponse } from '../../lib/types'
import { ErrorState, Loading, Warnings } from '../../components/States'
import { ApiError, apiSend } from '../../lib/api'
import { announceChange } from '../../lib/changes'

export function ProjectDetail({ projectId }: { projectId: string }): JSX.Element {
  const detail = useApi<ProjectDetailResponse>(`/api/projects/${encodeURIComponent(projectId)}`, 30000)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<ApiError | null>(null)

  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.reload} />
  if (detail.data === null) return <Loading label="Loading project…" />

  const { project, runs, events, malformedEvents, warnings } = detail.data

  const deleteProject = async (): Promise<void> => {
    if (!window.confirm(
      `Delete project “${project.name ?? project.projectId}”? Its metadata will move to recoverable trash. Repositories are never deleted, and projects used by runs or chats will be refused.`,
    )) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await apiSend(`/api/projects/${encodeURIComponent(project.projectId)}`, 'DELETE')
      announceChange()
      window.history.pushState(null, '', '/projects')
      window.dispatchEvent(new PopStateEvent('popstate'))
    } catch (cause) {
      setDeleteError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not delete this project.'))
      setDeleting(false)
    }
  }

  return (
    <>
      <p className="muted">
        <Link to="/projects">Projects</Link> / {project.projectId}
      </p>
      <div className="stack" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>{project.name ?? project.projectId}</h1>
          <p className="lede">{project.description || 'No description recorded.'}</p>
        </div>
        <div className="stack">
          <Link className="action" to={`/projects/${project.projectId}/edit`}>
            Edit project
          </Link>
          <Link className="action" to={`/runs/new?projectId=${encodeURIComponent(project.projectId)}`}>
            New run
          </Link>
          <Link
            className="action primary"
            to={`/design-panel/new?projectId=${encodeURIComponent(project.projectId)}`}
          >
            Start design panel
          </Link>
          <button className="action danger" type="button" disabled={deleting} onClick={() => void deleteProject()}>
            {deleting ? 'Deleting…' : 'Delete project'}
          </button>
        </div>
      </div>
      {deleteError ? <ErrorState error={deleteError} /> : null}
      <Warnings warnings={warnings} />

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Repositories</h2>
        {project.repoPaths.length === 0 ? (
          <p className="muted">None recorded.</p>
        ) : (
          <ul className="mono">
            {project.repoPaths.map((repo) => (
              <li key={repo}>{repo}</li>
            ))}
          </ul>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>
          Created {formatTime(project.createdAt)} · updated {formatTime(project.updatedAt)}
        </p>
      </div>

      <h2>Runs ({runs.length})</h2>
      {runs.length === 0 ? (
        <p className="muted">No runs under this project yet.</p>
      ) : (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Requirement</th>
                <th scope="col">State</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId}>
                  <td>
                    <Link to={`/runs/${run.runId}`}>{run.runId}</Link>
                  </td>
                  <td>{run.requirement ?? <span className="muted">(not stated)</span>}</td>
                  <td>
                    <span className={`badge ${stateTone(run.state)}`}>{run.state ?? 'unknown'}</span>
                  </td>
                  <td className="muted">{formatTime(run.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Project events</h2>
      {events.length === 0 ? (
        <p className="muted">Nothing recorded yet.</p>
      ) : (
        <div className="card">
          <ul className="timeline">
            {events.map((event, index) => (
              <li key={`${String(event.at)}-${index}`}>
                <span className="dot" />
                <span className="mono">{String(event.at ?? '')}</span>
                <span>{String(event.event ?? 'event')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {malformedEvents.length > 0 ? (
        <p className="banner warn">
          {malformedEvents.length} project event line(s) could not be parsed. They are kept on disk
          exactly as written.
        </p>
      ) : null}
    </>
  )
}
