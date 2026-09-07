import { useState } from 'react'
import { Link } from '../../lib/router'
import { formatTime } from '../../lib/format'
import { useApi } from '../../lib/useApi'
import type { ProjectListResponse } from '../../lib/types'
import { EmptyState, ErrorState, Loading, Warnings } from '../../components/States'
import { ApiError, apiSend } from '../../lib/api'
import { announceChange } from '../../lib/changes'

export function ProjectsView(): JSX.Element {
  const projects = useApi<ProjectListResponse>('/api/projects', 30000)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<ApiError | null>(null)

  const deleteProject = async (projectId: string, name: string): Promise<void> => {
    if (!window.confirm(
      `Delete project “${name}”? Its metadata will move to recoverable trash. Repositories are never deleted, and projects used by runs or chats will be refused.`,
    )) return
    setDeleting(projectId)
    setDeleteError(null)
    try {
      await apiSend(`/api/projects/${encodeURIComponent(projectId)}`, 'DELETE')
      announceChange()
      projects.reload()
    } catch (cause) {
      setDeleteError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not delete this project.'))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <>
      <div className="stack" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Projects</h1>
          <p className="lede">Projects group runs. They hold no workflow state of their own.</p>
        </div>
        <Link className="action primary" to="/projects/new">
          New project
        </Link>
      </div>

      {projects.error ? <ErrorState error={projects.error} onRetry={projects.reload} /> : null}
      {deleteError ? <ErrorState error={deleteError} /> : null}
      {projects.loading && projects.data === null ? <Loading label="Loading projects…" /> : null}
      <Warnings warnings={projects.data?.warnings ?? []} />

      {projects.data !== null && projects.data.projects.length === 0 ? (
        <EmptyState title="No projects yet">
          Create the first one — a name, and the repositories the work concerns.
        </EmptyState>
      ) : null}

      <div className="grid">
        {(projects.data?.projects ?? []).map((project) => (
          <article className="card" key={project.projectId}>
            <h2 style={{ margin: '0 0 4px' }}>
              <Link to={`/projects/${project.projectId}`}>{project.name ?? project.projectId}</Link>
            </h2>
            <div className="muted mono" style={{ fontSize: 12 }}>{project.projectId}</div>
            <p style={{ marginBottom: 8 }}>{project.description || <span className="muted">No description.</span>}</p>
            <div className="stack">
              <span className="badge">{project.runCount ?? 0} run(s)</span>
              <span className="badge">{project.repoPaths.length} repo(s)</span>
            </div>
            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              Last activity {formatTime(project.lastActivityAt)}
            </div>
            <button
              className="action danger"
              style={{ marginTop: 12 }}
              type="button"
              disabled={deleting === project.projectId}
              onClick={() => void deleteProject(project.projectId, project.name ?? project.projectId)}
            >
              {deleting === project.projectId ? 'Deleting…' : 'Delete project'}
            </button>
          </article>
        ))}
      </div>

      {projects.data !== null && projects.data.unassignedRunCount > 0 ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Unassigned</h2>
          <p className="muted">
            {projects.data.unassignedRunCount} run(s) belong to no project — including every run
            created before projects existed.
          </p>
          <Link className="action" to="/runs?projectId=unassigned">
            View unassigned runs
          </Link>
        </div>
      ) : null}
    </>
  )
}
