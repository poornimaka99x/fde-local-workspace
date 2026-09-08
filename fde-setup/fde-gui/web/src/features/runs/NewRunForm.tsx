import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, apiSend } from '../../lib/api'
import { announceChange } from '../../lib/changes'
import { useApi } from '../../lib/useApi'
import type {
  ClaudeAccountsResponse,
  ProjectListResponse,
  RoutingPolicyResponse,
  RunSummary,
} from '../../lib/types'
import { ErrorState } from '../../components/States'
import { ClaudeSettings } from '../../components/ClaudeSettings'
import type { ClaudeEffort } from '../../lib/types'
import { RoutingPreview } from './RoutingPreview'

const STRATEGY_LABELS: Record<string, string> = {
  balanced: 'Balanced',
  quality_first: 'Quality first',
  cost_first: 'Cost first',
}

const STRATEGY_HELP: Record<string, string> = {
  balanced: 'The cheapest choice that also carries the effort this policy prefers for work '
    + 'of this complexity.',
  quality_first: 'The highest tier and effort inside the approved ceiling.',
  cost_first: 'The lowest expected cost that still clears the quality floor — never one '
    + 'below it.',
}

/**
 * The new-run flow collects only launch choices and the ask. Scoping the plan
 * and assigning roles happen in the conversation with the orchestrator — this
 * form does not pre-empt either, and it approves nothing.
 *
 * Automatic model and effort selection is the recommended mode and the default.
 * Manual is kept exactly as it was, and choosing the account stays explicit in
 * both: authentication, organisational access and provider choice are operator
 * decisions, not routed ones.
 */
export function NewRunForm({ projectId }: { projectId?: string }): JSX.Element {
  const projects = useApi<ProjectListResponse>('/api/projects')
  const accounts = useApi<ClaudeAccountsResponse>('/api/claude/accounts')
  const routingPolicy = useApi<RoutingPolicyResponse>('/api/routing/policy')
  const [project, setProject] = useState(projectId ?? '')
  const [requirement, setRequirement] = useState('')
  const [orchestrator, setOrchestrator] = useState('work')
  const [model, setModel] = useState('default')
  const [effort, setEffort] = useState<ClaudeEffort>('auto')
  const [shape, setShape] = useState('')
  const [routingMode, setRoutingMode] = useState<'auto' | 'manual'>('auto')
  const [strategy, setStrategy] = useState('balanced')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  const policy = routingPolicy.data?.policy ?? null
  const routingAvailable = policy?.state === 'available'
  // Three states, not two. "We have not asked yet" is not the same as
  // "automatic routing is unavailable", and collapsing them showed the
  // recommended option as selected while quietly creating a manual run.
  const policyKnown = routingPolicy.data !== null || routingPolicy.error !== null
  const auto = routingMode === 'auto' && routingAvailable

  useEffect(() => {
    if (policyKnown && !routingAvailable) setRoutingMode('manual')
  }, [policyKnown, routingAvailable])
  const strategies = routingPolicy.data?.strategies ?? ['balanced', 'quality_first', 'cost_first']
  const minChars = routingPolicy.data?.previewMinRequirementChars ?? 24
  const selectedAccount = (accounts.data?.accounts ?? [])
    .find((candidate) => candidate.id === orchestrator) ?? null
  // Which provider the orchestrator belongs to, not which id it happens to
  // have. With one hard-coded Codex account the two were the same string; with
  // as many as the operator registers they are not, and comparing against the
  // literal 'codex' quietly stopped matching anything.
  const codexLed = selectedAccount?.provider === 'codex'
  // Until the account list has loaded there is no answer, and guessing "not
  // Codex" would send the operator to a session a Codex-led run cannot have.
  const providerKnown = selectedAccount !== null || accounts.error !== null

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const body: Record<string, unknown> = auto
        ? { orchestrator, routing: 'auto', strategy }
        : { orchestrator, model, effort, routing: 'manual' }
      if (project !== '') body.projectId = project
      if (requirement.trim() !== '') body.requirement = requirement.trim()
      if (shape.trim() !== '') body.shape = shape.trim()
      const created = await apiSend<{ run: RunSummary }>('/api/runs', 'POST', body)
      announceChange()
      const destination = shape.trim() === 'design-panel'
        ? `/design-panel/new?runId=${encodeURIComponent(created.run.runId)}`
        : `/runs/${created.run.runId}${codexLed ? '' : '?startSession=1'}`
      window.history.pushState(null, '', destination)
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
      <p className="card">
        Designing a screen or a flow?{' '}
        <a href={project === '' ? '/design-panel/new' : `/design-panel/new?projectId=${encodeURIComponent(project)}`}>
          Start a design panel
        </a>{' '}
        instead: two or three Claude accounts get the same sealed context, work independently, and
        are reconciled into one recommendation.
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
        <fieldset style={{ border: 'none', padding: 0, margin: '0 0 1rem' }}>
          <legend><strong>Model and effort</strong></legend>
          <p>
            <label>
              <input
                type="radio"
                name="routing-mode"
                value="auto"
                checked={routingMode === 'auto'}
                disabled={!policyKnown || !routingAvailable}
                onChange={() => setRoutingMode('auto')}
              />{' '}
              Automatic model and effort <span className="muted">(recommended)</span>
              <br />
              <span className="muted">
                The controller selects a concrete model and effort for the account you choose,
                and proposes the specialist tasks. You still approve everything.
              </span>
            </label>
          </p>
          <p>
            <label>
              <input
                type="radio"
                name="routing-mode"
                value="manual"
                checked={routingMode === 'manual'}
                disabled={!policyKnown}
                onChange={() => setRoutingMode('manual')}
              />{' '}
              Manual
              <br />
              <span className="muted">Choose the model and the effort yourself.</span>
            </label>
          </p>
          {!policyKnown ? (
            <p className="muted" role="status">
              Checking whether this controller offers automatic routing…
            </p>
          ) : null}
          {routingPolicy.error !== null ? (
            <p className="banner warn" role="status">
              <strong>Could not ask the controller about automatic routing: </strong>
              {routingPolicy.error.message} Manual selection still works, and this run
              will use the model and effort you choose below.
            </p>
          ) : null}
          {!routingAvailable && routingPolicy.data !== null ? (
            <p className="banner warn" role="status">
              <strong>Automatic routing is unavailable: </strong>
              {policy?.message ?? 'this controller does not offer a routing policy.'}{' '}
              Manual selection still works.
            </p>
          ) : null}
        </fieldset>

        {auto ? (
          <p>
            <label>
              <strong>Strategy</strong>
              <br />
              <select
                value={strategy}
                onChange={(event) => setStrategy(event.target.value)}
              >
                {strategies.map((option) => (
                  <option key={option} value={option}>
                    {STRATEGY_LABELS[option] ?? option}
                  </option>
                ))}
              </select>
            </label>
            <br />
            <span className="muted">{STRATEGY_HELP[strategy] ?? ''}</span>
          </p>
        ) : null}

        <ClaudeSettings
          accountId={orchestrator}
          model={model}
          effort={effort}
          onAccount={setOrchestrator}
          onModel={setModel}
          onEffort={setEffort}
          includeCodex
          lockModelAndEffort={auto}
          lockedNote="Chosen by the controller for this account. Switch to Manual to pick them yourself."
        />

        <RoutingPreview
          enabled={auto}
          orchestrator={orchestrator}
          strategy={strategy}
          requirement={requirement}
          shape={shape}
          projectId={project}
          minChars={minChars}
          account={selectedAccount}
        />
        {codexLed ? (
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
          <button
            className="action primary"
            type="submit"
            disabled={saving || requirement.trim() === '' || !policyKnown}
          >
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
