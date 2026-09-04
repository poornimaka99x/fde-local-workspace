import { useState, type FormEvent } from 'react'
import { ApiError, apiSend } from '../../lib/api'
import { announceChange } from '../../lib/changes'
import { useApi } from '../../lib/useApi'
import type { ProjectListResponse, RunSummary } from '../../lib/types'
import { ErrorState } from '../../components/States'
import { ClaudeSettings } from '../../components/ClaudeSettings'
import type { ClaudeEffort } from '../../lib/types'

/**
 * The new-run flow collects only launch choices and the ask. Scoping the plan
 * and assigning roles happen in the conversation with the orchestrator — this
 * form does not pre-empt either, and it approves nothing.
 */
export function NewRunForm({ projectId }: { projectId?: string }): JSX.Element {
  const projects = useApi<ProjectListResponse>('/api/projects')
  const [project, setProject] = useState(projectId ?? '')
  const [requirement, setRequirement] = useState('')
  const [orchestrator, setOrchestrator] = useState('work')
  const [model, setModel] = useState('default')
  const [effort, setEffort] = useState<ClaudeEffort>('auto')
  const [shape, setShape] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { orchestrator, model, effort }
      if (project !== '') body.projectId = project
      if (requirement.trim() !== '') body.requirement = requirement.trim()
      if (shape.trim() !== '') body.shape = shape.trim()
      const created = await apiSend<{ run: RunSummary }>('/api/runs', 'POST', body)
      announceChange()
      const startSession = orchestrator === 'codex' ? '' : '?startSession=1'
      window.history.pushState(null, '', `/runs/${created.run.runId}${startSession}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not reach the local server.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h1>New run</h1>
      <p className="lede">
        A run starts by choosing who orchestrates it and saying what you want. Roles, the plan and
        every approval come next, in the conversation — not here.
      </p>
      {error ? <ErrorState error={error} /> : null}
      <form className="card" onSubmit={(event) => void submit(event)}>
        <p>
          <label>
            <strong>Project</strong>
            <br />
            <select value={project} onChange={(event) => setProject(event.target.value)}>
              <option value="">none (unassigned)</option>
              {(projects.data?.projects ?? []).map((option) => (
                <option key={option.projectId} value={option.projectId}>
                  {option.name ?? option.projectId}
                </option>
              ))}
            </select>
          </label>
        </p>
        <p>
          <label>
            <strong>What do you want done?</strong>{' '}
            <span className="muted">a Jira key at the start is picked up automatically</span>
            <br />
            <textarea
              value={requirement}
              rows={4}
              required
              maxLength={4000}
              style={{ width: '100%', maxWidth: 640 }}
              onChange={(event) => setRequirement(event.target.value)}
            />
          </label>
        </p>
        <ClaudeSettings
          accountId={orchestrator}
          model={model}
          effort={effort}
          onAccount={setOrchestrator}
          onModel={setModel}
          onEffort={setEffort}
          includeCodex
        />
        {orchestrator === 'codex' ? (
          <p className="banner warn">
            A Codex-led run is driven from its own Codex task. The console will show its state and
            files, but it cannot resume it and will not pretend otherwise.
          </p>
        ) : null}
        <p>
          <label>
            <strong>Named shape</strong> <span className="muted">optional — see <code>fde shapes</code></span>
            <br />
            <input
              type="text"
              value={shape}
              placeholder="research, presentation+delivery-plan, …"
              onChange={(event) => setShape(event.target.value)}
            />
          </label>
        </p>
        <div className="stack">
          <button className="action" type="submit" disabled={saving || requirement.trim() === ''}>
            {saving ? 'Creating…' : 'Create run'}
          </button>
          <a className="action" href="/runs">
            Cancel
          </a>
        </div>
      </form>
    </>
  )
}
