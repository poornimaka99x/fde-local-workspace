import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, apiSend } from '../../lib/api'
import { announceChange } from '../../lib/changes'
import { useApi } from '../../lib/useApi'
import type { ProjectDetailResponse, ProjectRecord } from '../../lib/types'
import { ErrorState, Loading } from '../../components/States'
import { PathBrowser } from '../../components/PathBrowser'

interface Saved {
  project: ProjectRecord
}

/**
 * Create or edit a project. A project is a grouping — a name, a description and
 * repository paths that must already exist. Nothing here touches a repository,
 * and there is no delete.
 */
export function ProjectForm({ projectId }: { projectId?: string }): JSX.Element {
  const editing = projectId !== undefined
  const existing = useApi<ProjectDetailResponse>(
    editing ? `/api/projects/${encodeURIComponent(projectId)}` : null,
  )
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [repos, setRepos] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [browsing, setBrowsing] = useState(false)

  useEffect(() => {
    const project = existing.data?.project
    if (!project) return
    setName(project.name ?? '')
    setDescription(project.description ?? '')
    setRepos(project.repoPaths.join('\n'))
  }, [existing.data])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    const repoPaths = repos
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    try {
      const body: Record<string, unknown> = { name: name.trim(), description }
      if (repoPaths.length > 0 || editing) body.repoPaths = repoPaths
      const saved = editing
        ? await apiSend<Saved>(`/api/projects/${encodeURIComponent(projectId)}`, 'PATCH', body)
        : await apiSend<Saved>('/api/projects', 'POST', body)
      announceChange()
      const to = `/projects/${saved.project.projectId}`
      window.history.pushState(null, '', to)
      window.dispatchEvent(new PopStateEvent('popstate'))
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not reach the local server.'))
    } finally {
      setSaving(false)
    }
  }

  if (editing && existing.loading && existing.data === null) return <Loading label="Loading project…" />

  return (
    <>
      <h1>{editing ? 'Edit project' : 'New project'}</h1>
      <p className="lede">
        Repository paths must already exist on this machine. The console reads about them; it never
        clones, changes or deletes one.
      </p>
      {error ? <ErrorState error={error} /> : null}
      <form className="card" onSubmit={(event) => void submit(event)}>
        <p>
          <label>
            <strong>Name</strong>
            <br />
            <input
              type="text"
              value={name}
              required
              maxLength={200}
              style={{ width: '100%', maxWidth: 480 }}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        </p>
        <p>
          <label>
            <strong>Description</strong>
            <br />
            <textarea
              value={description}
              rows={3}
              maxLength={2000}
              style={{ width: '100%', maxWidth: 640 }}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        </p>
        <p>
          <label>
            <strong>Repositories</strong> <span className="muted">one absolute path per line</span>
            <br />
            <textarea
              value={repos}
              rows={4}
              className="mono"
              style={{ width: '100%', maxWidth: 640 }}
              onChange={(event) => setRepos(event.target.value)}
            />
          </label>
          <button className="action" type="button" style={{ marginTop: 6 }} onClick={() => setBrowsing(true)}>
            Browse…
          </button>
        </p>
        {browsing ? (
          <PathBrowser
            title="Choose a repository folder"
            mode="directory"
            onSelect={(picked) => {
              setRepos((current) => {
                const lines = current.split('\n').map((line) => line.trim()).filter((line) => line !== '')
                if (!lines.includes(picked)) lines.push(picked)
                return lines.join('\n')
              })
              setBrowsing(false)
            }}
            onClose={() => setBrowsing(false)}
          />
        ) : null}
        <div className="stack">
          <button className="action" type="submit" disabled={saving || name.trim() === ''}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create project'}
          </button>
          <a className="action" href={editing ? `/projects/${projectId}` : '/projects'}>
            Cancel
          </a>
        </div>
      </form>
    </>
  )
}
