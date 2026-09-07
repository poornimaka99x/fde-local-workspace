import { useMemo, useState } from 'react'
import { Link } from '../../lib/router'
import { formatTime, stateTone } from '../../lib/format'
import { useApi } from '../../lib/useApi'
import type { ProjectListResponse, RunListResponse } from '../../lib/types'
import { EmptyState, ErrorState, Loading, Warnings } from '../../components/States'
import { ApiError, apiSend } from '../../lib/api'
import { announceChange } from '../../lib/changes'

export function RunsView({
  projectId,
  initialQuery,
}: {
  projectId?: string
  initialQuery?: string
}): JSX.Element {
  const [query, setQuery] = useState(initialQuery ?? '')
  const [state, setState] = useState('')
  const [orchestrator, setOrchestrator] = useState('')
  const [resumable, setResumable] = useState('')
  const [project, setProject] = useState(projectId ?? '')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<ApiError | null>(null)

  const path = useMemo(() => {
    const params = new URLSearchParams()
    if (query.trim() !== '') params.set('query', query.trim())
    if (state !== '') params.set('state', state)
    if (orchestrator !== '') params.set('orchestrator', orchestrator)
    if (resumable !== '') params.set('resumable', resumable)
    if (project !== '') params.set('projectId', project)
    const search = params.toString()
    return `/api/runs${search === '' ? '' : `?${search}`}`
  }, [query, state, orchestrator, resumable, project])

  const runs = useApi<RunListResponse>(path, 20000)
  const projects = useApi<ProjectListResponse>('/api/projects')
  // Filter options come from the unfiltered list, so choosing one filter never
  // makes the others disappear.
  const everything = useApi<RunListResponse>('/api/runs')

  const states = useMemo(() => {
    const seen = new Set<string>()
    for (const run of everything.data?.runs ?? []) if (run.state) seen.add(run.state)
    return [...seen].sort()
  }, [everything.data])

  const orchestrators = useMemo(() => {
    const seen = new Map<string, string>()
    for (const run of everything.data?.runs ?? []) {
      if (run.orchestrator) seen.set(run.orchestrator.agentId, run.orchestrator.label)
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [everything.data])

  const deleteRun = async (runId: string): Promise<void> => {
    if (!window.confirm(
      `Delete run “${runId}”? Its complete record, attachments, and artifacts will move to recoverable trash. Repositories and project metadata are not deleted.`,
    )) return
    setDeleting(runId)
    setDeleteError(null)
    try {
      await apiSend(`/api/runs/${encodeURIComponent(runId)}`, 'DELETE')
      announceChange()
      runs.reload()
      everything.reload()
      projects.reload()
    } catch (cause) {
      setDeleteError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not delete this run.'))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <>
      <div className="stack" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>Runs</h1>
          <p className="lede">
            Every run the controller knows about. State comes from the controller — never inferred
            from which files happen to exist.
          </p>
        </div>
        <Link className="action" to="/runs/new">
          New run
        </Link>
      </div>

      <div className="card stack" role="search">
        <label>
          <span className="muted">Search </span>
          <input
            type="search"
            value={query}
            placeholder="run id, requirement or Jira key"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span className="muted">State </span>
          <select value={state} onChange={(event) => setState(event.target.value)}>
            <option value="">any</option>
            {states.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="muted">Project </span>
          <select value={project} onChange={(event) => setProject(event.target.value)}>
            <option value="">any</option>
            <option value="unassigned">unassigned</option>
            {(projects.data?.projects ?? []).map((option) => (
              <option key={option.projectId} value={option.projectId}>
                {option.name ?? option.projectId}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="muted">Orchestrator </span>
          <select value={orchestrator} onChange={(event) => setOrchestrator(event.target.value)}>
            <option value="">any</option>
            {orchestrators.map(([agentId, label]) => (
              <option key={agentId} value={agentId}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="muted">Session </span>
          <select value={resumable} onChange={(event) => setResumable(event.target.value)}>
            <option value="">any</option>
            <option value="true">resumable</option>
            <option value="false">not resumable</option>
          </select>
        </label>
        <button className="action" type="button" onClick={runs.reload}>
          Refresh
        </button>
      </div>

      {runs.error ? <ErrorState error={runs.error} onRetry={runs.reload} /> : null}
      {deleteError ? <ErrorState error={deleteError} /> : null}
      {runs.loading && runs.data === null ? <Loading label="Loading runs…" /> : null}
      <Warnings warnings={runs.data?.warnings ?? []} />

      {runs.data !== null && runs.data.runs.length === 0 ? (
        <EmptyState title="No runs match">
          {runs.data.total === 0
            ? 'No runs exist yet. Start one with fde-start, or fde start on the command line.'
            : 'Every run was filtered out. Widen the filters above.'}
        </EmptyState>
      ) : null}

      {runs.data !== null && runs.data.runs.length > 0 ? (
        <div className="card table-scroll">
          <table>
            <caption className="muted" style={{ captionSide: 'bottom', textAlign: 'left', paddingTop: 8 }}>
              {runs.data.returned} of {runs.data.total} runs, newest activity first
            </caption>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Requirement</th>
                <th scope="col">Project</th>
                <th scope="col">Orchestrator</th>
                <th scope="col">State</th>
                <th scope="col">Session</th>
                <th scope="col">Updated</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.runs.map((run) => (
                <tr key={run.runId}>
                  <td>
                    <Link to={`/runs/${run.runId}`}>{run.runId}</Link>
                    {run.malformed ? <div className="badge danger">manifest unreadable</div> : null}
                  </td>
                  <td>{run.requirement ?? <span className="muted">(not stated)</span>}</td>
                  <td>
                    {run.projectId ? (
                      <Link to={`/projects/${run.projectId}`}>{run.projectId}</Link>
                    ) : (
                      <span className="muted">unassigned</span>
                    )}
                  </td>
                  <td>{run.orchestrator?.label ?? <span className="muted">(not chosen)</span>}</td>
                  <td>
                    <span className={`badge ${stateTone(run.state)}`}>{run.state ?? 'unknown'}</span>
                  </td>
                  <td>
                    {run.session.resumable ? (
                      <span className="badge ok">resumable</span>
                    ) : (
                      <span className="muted">{run.session.resumeReason ?? '—'}</span>
                    )}
                  </td>
                  <td className="muted">{formatTime(run.updatedAt)}</td>
                  <td>
                    <button
                      className="action danger"
                      type="button"
                      disabled={deleting === run.runId}
                      onClick={() => void deleteRun(run.runId)}
                    >
                      {deleting === run.runId ? 'Deleting…' : 'Delete run'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  )
}
