import { useState } from 'react'
import { ApiError, apiGet, apiSend } from '../../lib/api'
import { formatTime, shortHash } from '../../lib/format'
import { useApi } from '../../lib/useApi'
import { announceChange } from '../../lib/changes'
import type {
  RoutedTask,
  RoutingAttemptsResponse,
  RoutingExplainResponse,
  RoutingShowResponse,
  RunStatus,
} from '../../lib/types'
import { ErrorState, Loading } from '../../components/States'
import {
  AssessmentDetails,
  bandTone,
  Ceiling,
  confidenceTone,
  CostUnits,
  UsageBlock,
  WhyThisChoice,
} from './RoutingExplanation'

/**
 * The run's proposed — or approved — execution matrix.
 *
 * The whole point of this view is that the four things an operator has to check
 * are four different things: which account holds the work, which focused method
 * it runs, which model, and at which effort. They are four columns and they are
 * never collapsed into one badge. Independence is stated in words rather than
 * implied by a row existing, ceilings are shown next to what has actually been
 * spent, and every explanation is a keyboard-operable `<details>` rather than a
 * colour.
 *
 * Nothing in here approves anything. The plan, the roles and the route are
 * approved together in the conversation, with the exact phrase.
 */
export function RoutingMatrix({ run }: { run: RunStatus }): JSX.Element {
  const routing = useApi<RoutingShowResponse>(
    run.routing?.present === true ? `/api/runs/${encodeURIComponent(run.runId)}/routing` : null)
  const attempts = useApi<RoutingAttemptsResponse>(
    run.routing?.present === true
      ? `/api/runs/${encodeURIComponent(run.runId)}/routing/attempts`
      : null)

  if (run.routing === null) {
    return (
      <>
        <h2>Routing</h2>
        <div className="card">
          <p style={{ marginTop: 0 }}>
            This run selects its model and effort manually, which is how every run worked
            before automatic routing existed.
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            Start a new run with <strong>Automatic model and effort</strong> to have the
            controller choose them and propose the specialist tasks.
          </p>
        </div>
      </>
    )
  }

  if (run.routing.readable === false) {
    return (
      <>
        <h2>Routing</h2>
        <p className="banner warn" role="status">
          <strong>This run&rsquo;s routing record could not be read: </strong>
          {run.routing.message ?? run.routing.error ?? 'unknown reason'}
        </p>
      </>
    )
  }

  if (routing.error) return <ErrorState error={routing.error} onRetry={routing.reload} />
  if (routing.data === null) return <Loading label="Loading the route…" />

  const decision = routing.data.routing
  const { assessment } = decision
  const approved = decision.approvedAt !== null && decision.approvedAt !== undefined
  const drifted = run.routing.approved === true && run.routing.planHashMatches === false

  return (
    <>
      <h2>Routing</h2>

      <div className="card">
        <div className="stack" style={{ flexWrap: 'wrap' }}>
          <span className={`badge ${approved ? 'ok' : 'warn'}`}>
            {approved ? 'approved and frozen' : 'proposed, not approved'}
          </span>
          <span className={`badge ${bandTone(assessment.band)}`}>
            complexity: {assessment.band}
          </span>
          <span className={`badge ${confidenceTone(assessment.confidence)}`}>
            confidence: {assessment.confidence}
          </span>
          <span className="badge">floor: {assessment.qualityFloor}</span>
          <span className="badge">strategy: {decision.strategy}</span>
          <span className="muted">policy {decision.policyRevision}</span>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          {approved ? (
            <>
              Frozen at {formatTime(decision.approvedAt)} with decision{' '}
              <span className="mono">{shortHash(decision.decisionHash)}</span>. Every
              invocation is checked against it.
            </>
          ) : (
            <>
              A proposal authorises nothing. It is recomputed whenever the plan or the roles
              change, and it is frozen by <span className="mono">APPROVE PLAN {run.runId}</span>{' '}
              in the conversation — not here.
            </>
          )}
        </p>
      </div>

      {drifted ? (
        <p className="banner warn" role="status">
          <strong>The plan or roles changed after this route was approved.</strong> The frozen
          route no longer describes this run, so every invocation is refused until it is
          approved again. Run{' '}
          <span className="mono">fde approve-plan {run.runId} --reapprove</span>.
        </p>
      ) : null}

      {assessment.clarification ? (
        <p className="banner warn" role="status">
          <strong>Worth answering first: </strong>
          {assessment.clarification}
        </p>
      ) : null}

      {decision.warnings.map((warning) => (
        <p className="banner warn" key={warning} role="status">{warning}</p>
      ))}

      <Ceilings run={run} decision={decision} attempts={attempts.data} />

      <h3>Orchestrator</h3>
      <div className="card">
        <table>
          <tbody>
            <tr>
              <th scope="row">Account identity</th>
              <td>
                {decision.orchestrator.accountLabel
                  ?? decision.orchestrator.accountId
                  ?? 'not chosen'}
              </td>
            </tr>
            <tr>
              <th scope="row">Model and effort</th>
              <td>
                {decision.orchestrator.routable ? (
                  <span className="mono">
                    {decision.orchestrator.model} / {decision.orchestrator.effort}
                  </span>
                ) : (
                  <span className="muted">{decision.orchestrator.reason}</span>
                )}
              </td>
            </tr>
            <tr>
              <th scope="row">Estimated cost</th>
              <td><CostUnits value={decision.orchestrator.expectedCostUnits} /></td>
            </tr>
            <tr>
              <th scope="row">Escalation ceiling</th>
              <td><Ceiling ceiling={decision.orchestrator.escalationCeiling} /></td>
            </tr>
          </tbody>
        </table>
        <WhyThisChoice
          reason={decision.orchestrator.reason}
          strategyRule={decision.orchestrator.strategyRule}
          alternatives={decision.orchestrator.alternatives}
          rejected={decision.orchestrator.rejected}
          limitations={decision.orchestrator.limitations}
        />
      </div>

      <h3>Execution matrix</h3>
      {decision.tasks.length === 0 ? (
        <div className="card muted">
          No tasks have been proposed yet. The plan and the role assignment decide these.
        </div>
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table>
            <caption className="muted">
              Account identity, specialist method, model and effort are four separate
              choices. A method is what the account will run; the account is who runs it.
            </caption>
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Stage</th>
                <th scope="col">Role</th>
                <th scope="col">Specialist method</th>
                <th scope="col">Account identity</th>
                <th scope="col">Model / effort</th>
                <th scope="col">Floor</th>
                <th scope="col">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {decision.tasks.map((task) => (
                <tr key={task.taskId}>
                  <th scope="row" className="mono">{task.taskId}</th>
                  <td>{task.stageLabel ?? task.stage}</td>
                  <td>{task.roleLabel ?? task.requiredRole}</td>
                  <td>
                    {task.specialist === null || task.specialist === undefined ? (
                      <span className="muted">
                        none — the account holding the role does this stage itself
                      </span>
                    ) : (
                      <span className="mono">{task.specialist}</span>
                    )}
                  </td>
                  <td>
                    {task.accountLabel ?? task.accountId ?? '—'}
                    {task.accountAvailable === false ? (
                      <>
                        {' '}
                        <span className="badge warn">not available on this machine</span>
                      </>
                    ) : null}
                  </td>
                  <td className="mono">
                    {task.routable
                      ? `${task.model ?? '?'} / ${task.effort ?? '?'}`
                      : 'not selectable'}
                  </td>
                  <td>{task.qualityFloor}</td>
                  <td><CostUnits value={task.estimatedCostUnits} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {decision.tasks.map((task) => (
        <TaskDetail key={task.taskId} run={run} task={task} onChanged={() => {
          routing.reload()
          attempts.reload()
        }} />
      ))}

      {decision.notScheduled.length > 0 ? (
        <details className="card">
          <summary>Not scheduled ({decision.notScheduled.length})</summary>
          <ul>
            {decision.notScheduled.map((entry) => (
              <li key={`${entry.stage}-${entry.role}`}>
                <span className="mono">
                  {entry.stage}/{entry.role}
                </span>{' '}
                — {entry.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <AssessmentDetails assessment={assessment} />
      <Overrides decision={decision} />
      <UsageBlock usage={attempts.data?.usage ?? run.routing.usage} />
      <Attempts attempts={attempts.data} />
    </>
  )
}

/** What was approved, against what has actually been spent. */
function Ceilings({ run, decision, attempts }: {
  run: RunStatus
  decision: RoutingShowResponse['routing']
  attempts: RoutingAttemptsResponse | null
}): JSX.Element {
  const limits = decision.limits
  const spent = attempts?.spentCostUnits ?? run.routing?.spentCostUnits ?? 0
  const cap = limits.maxCostUnits ?? null
  return (
    <div className="card">
      <strong>Approved ceilings</strong>
      <table>
        <tbody>
          <tr>
            <th scope="row">Cost units</th>
            <td>
              <CostUnits value={spent} prefix="~" /> spent of{' '}
              {cap === null ? <span className="muted">no ceiling</span> : <>{cap} approved</>}
              {' '}
              <span className="muted">
                (estimates from the policy&rsquo;s cost weights, not money)
              </span>
            </td>
          </tr>
          <tr>
            <th scope="row">Model ceiling</th>
            <td>
              <span className="mono">{limits.maxAutomaticTier ?? '—'}</span> tier at{' '}
              <span className="mono">{limits.maxAutomaticEffort ?? '—'}</span> effort
            </td>
          </tr>
          <tr>
            <th scope="row">Retries</th>
            <td>
              {typeof limits.maxRetries === 'number'
                ? `${limits.maxRetries} per task`
                : 'not recorded'}
            </td>
          </tr>
          <tr>
            <th scope="row">Agents</th>
            <td>
              {limits.maxSpecialists ?? '—'} specialist method(s),{' '}
              {limits.maxSpecialistsPerStage ?? '—'} per stage,{' '}
              {limits.maxParallel ?? '—'} in parallel
            </td>
          </tr>
          <tr>
            <th scope="row">Independent review</th>
            <td>
              {limits.requireIndependentReview === true
                ? 'required for this band'
                : 'not required for this band'}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

/**
 * One task, expandable: why the method exists, why the model, what it is
 * allowed to escalate to, and — where it applies — whether its independence is
 * real or degraded.
 */
function TaskDetail({ run, task, onChanged }: {
  run: RunStatus
  task: RoutedTask
  onChanged: () => void
}): JSX.Element {
  const [explain, setExplain] = useState<RoutingExplainResponse | null>(null)
  const [explainError, setExplainError] = useState<ApiError | null>(null)

  // The full candidate set is fetched only when the operator opens this task:
  // the matrix is the summary, and the argument for one row is not worth
  // fetching for every row nobody looked at.
  const load = async (): Promise<void> => {
    if (explain !== null) return
    try {
      setExplain(await apiGet<RoutingExplainResponse>(
        `/api/runs/${encodeURIComponent(run.runId)}/routing/explain`
        + `?taskId=${encodeURIComponent(task.taskId)}`))
    } catch (cause) {
      setExplainError(cause instanceof ApiError
        ? cause
        : new ApiError(0, 'network', 'Could not load the explanation.'))
    }
  }

  return (
    <details className="card" onToggle={(event) => {
      if ((event.currentTarget as HTMLDetailsElement).open) void load()
    }}>
      <summary>
        <span className="mono">{task.taskId}</span> — {task.stageLabel ?? task.stage}
        {task.independence ? (
          <>
            {' '}
            <span className={`badge ${task.independence.independent ? 'ok' : 'danger'}`}>
              {task.independence.independent
                ? 'independent check'
                : 'degraded independence'}
            </span>
          </>
        ) : null}
      </summary>

      <p>{task.objective}</p>

      <table>
        <tbody>
          <tr>
            <th scope="row">Why this method exists</th>
            <td>{task.specialistReason ?? task.reason ?? 'no reason recorded'}</td>
          </tr>
          <tr>
            <th scope="row">Runs after</th>
            <td>
              {task.dependsOn.length === 0
                ? 'nothing'
                : task.dependsOn.join(', ')}
              {task.parallelizable ? ' · may run in parallel' : ' · sequential'}
            </td>
          </tr>
          <tr>
            <th scope="row">Escalation ceiling</th>
            <td><Ceiling ceiling={task.escalationCeiling} /></td>
          </tr>
          {task.progress ? (
            <tr>
              <th scope="row">Attempts</th>
              <td>
                {task.progress.attempts} recorded — {task.progress.retries} beyond
                the first, of which {task.progress.escalations} escalated —{' '}
                <CostUnits value={task.progress.spentCostUnits} /> spent
                {task.progress.lastOutcome
                  ? ` · last outcome: ${task.progress.lastOutcome}`
                  : ''}
                {task.progress.lastClassification
                  ? ` (${task.progress.lastClassification})`
                  : ''}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {task.independence && !task.independence.independent ? (
        <p className="banner warn" role="status">
          <strong>This check is not independent. </strong>
          {task.independence.reason}
          {task.independence.requiresDegradedApproval
            ? ' The existing degraded-operation approval applies before relying on it.'
            : ''}
        </p>
      ) : null}

      <WhyThisChoice
        reason={task.reason}
        strategyRule={task.strategyRule}
        alternatives={explain?.alternativesConsidered ?? task.alternatives}
        rejected={explain?.rejected ?? task.rejected}
        limitations={explain?.target.limitations}
      />
      {explainError !== null ? (
        <p className="muted">The full explanation could not be loaded: {explainError.message}</p>
      ) : null}
      {explain?.policyDrift ? (
        <p className="banner warn" role="status">{explain.policyDrift}</p>
      ) : null}

      <OverrideForm run={run} task={task} onChanged={onChanged} />
    </details>
  )
}

/**
 * Change one routed decision, on the record.
 *
 * A reason is required because it is the only part of the record that explains
 * itself later. Raising a tier, an effort or an account is a change to what was
 * approved, so the operator types the phrase — this form never fills it in.
 */
function OverrideForm({ run, task, onChanged }: {
  run: RunStatus
  task: RoutedTask
  onChanged: () => void
}): JSX.Element {
  const [model, setModel] = useState(task.model ?? '')
  const [effort, setEffort] = useState(task.effort ?? '')
  const [reason, setReason] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const phrase = `APPROVE ROUTING ${run.runId}`

  const submit = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    setDone(null)
    try {
      const body: Record<string, unknown> = { taskId: task.taskId, reason }
      if (model.trim() !== '') body.model = model.trim()
      if (effort.trim() !== '') body.effort = effort.trim()
      if (confirmation.trim() !== '') body.confirmation = confirmation.trim()
      const answer = await apiSend<{ changes: { field: string; from: unknown; to: unknown }[] }>(
        `/api/runs/${encodeURIComponent(run.runId)}/routing/override`, 'POST', body)
      setDone(answer.changes.map((change) =>
        `${change.field}: ${String(change.from)} → ${String(change.to)}`).join(', '))
      setReason('')
      setConfirmation('')
      announceChange()
      onChanged()
    } catch (cause) {
      setError(cause instanceof ApiError
        ? cause
        : new ApiError(0, 'network', 'Could not record the override.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <details>
      <summary>Override this decision</summary>
      <p className="muted">
        A quality floor is not negotiable by override, and raising a model tier, an effort or
        an account needs the phrase below. Whatever you change is recorded with your name, the
        time, the old value, the new value and your reason. Nothing is overwritten.
      </p>
      {error !== null ? (
        <p className="banner warn" role="status">
          <strong>{error.message}</strong>
          {error.detail ? <> {error.detail}</> : null}
        </p>
      ) : null}
      {done !== null ? (
        <p className="banner ok" role="status">Recorded: {done}</p>
      ) : null}
      <div className="form-grid">
        <label>
          <strong>Model</strong>
          <input
            type="text"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
        <label>
          <strong>Effort</strong>
          <input
            type="text"
            value={effort}
            onChange={(event) => setEffort(event.target.value)}
          />
        </label>
      </div>
      <p>
        <label>
          <strong>Reason</strong> <span className="muted">required</span>
          <br />
          <textarea
            value={reason}
            rows={2}
            maxLength={500}
            style={{ width: '100%', maxWidth: 640 }}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      </p>
      <p>
        <label>
          <strong>Approval phrase</strong>{' '}
          <span className="muted">
            only needed when this raises a tier, an effort or an account — type{' '}
            <span className="mono">{phrase}</span>
          </span>
          <br />
          <input
            type="text"
            value={confirmation}
            style={{ width: '100%', maxWidth: 640 }}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
      </p>
      <button
        className="action"
        type="button"
        disabled={saving || reason.trim() === ''}
        onClick={() => void submit()}
      >
        {saving ? 'Recording…' : 'Record override'}
      </button>
    </details>
  )
}

function Overrides({ decision }: { decision: RoutingShowResponse['routing'] }): JSX.Element | null {
  if (decision.overrides.length === 0 && decision.supersededApprovals.length === 0) return null
  return (
    <details className="card">
      <summary>
        Overrides and superseded approvals ({decision.overrides.length}
        {decision.supersededApprovals.length > 0
          ? ` + ${decision.supersededApprovals.length}`
          : ''}
        )
      </summary>
      {decision.overrides.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">What</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {decision.overrides.map((entry, index) => (
              <tr key={`${entry.at}-${entry.field}-${index}`}>
                <td>{formatTime(entry.at)}</td>
                <td>{entry.operator ?? 'unknown'}</td>
                <td>
                  <span className="mono">{entry.target}.{entry.field}</span>:{' '}
                  {String(entry.from)} → {String(entry.to)}
                  {entry.escalation ? (
                    <>
                      {' '}
                      <span className="badge warn">raised what was approved</span>
                    </>
                  ) : null}
                </td>
                <td>{entry.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {decision.supersededApprovals.length > 0 ? (
        <>
          <strong>Superseded approvals</strong>
          <ul>
            {decision.supersededApprovals.map((entry) => (
              <li key={`${entry.approvedAt}-${entry.decisionHash}`}>
                Approved {formatTime(entry.approvedAt)} by {entry.approvedBy ?? 'unknown'} as{' '}
                <span className="mono">{shortHash(entry.decisionHash)}</span>, superseded{' '}
                {formatTime(entry.supersededAt)} — {entry.reason}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </details>
  )
}

function Attempts({ attempts }: { attempts: RoutingAttemptsResponse | null }): JSX.Element | null {
  if (attempts === null || attempts.attempts.length === 0) return null
  return (
    <details className="card">
      <summary>Attempts ({attempts.attempts.length})</summary>
      <p className="muted">
        Every attempt keeps its own artifact and its own line in the ledger. A failed attempt
        is the evidence for the escalation that follows it, so it is never replaced.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">#</th>
              <th scope="col">Mode</th>
              <th scope="col">Model / effort</th>
              <th scope="col">Outcome</th>
              <th scope="col">Classification</th>
              <th scope="col">Est. cost</th>
            </tr>
          </thead>
          <tbody>
            {attempts.attempts.map((attempt) => (
              <tr key={`${attempt.taskId}-${attempt.attempt}`}>
                <th scope="row" className="mono">{attempt.taskId}</th>
                <td>{attempt.attempt}</td>
                <td>{attempt.mode}</td>
                <td className="mono">
                  {attempt.model} / {attempt.effort}
                </td>
                <td>{attempt.outcome ?? 'unjudged'}</td>
                <td>{attempt.classification ?? '—'}</td>
                <td><CostUnits value={attempt.estimatedCostUnits} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {attempts.ledger.length > attempts.attempts.length ? (
        <details>
          <summary>
            Full ledger ({attempts.ledger.length} line
            {attempts.ledger.length === 1 ? '' : 's'})
          </summary>
          <p className="muted">
            Recording an outcome appends a line rather than editing the attempt it
            describes, so the table above is this ledger replayed. Nothing here was
            rewritten.
          </p>
          <ul>
            {attempts.ledger.map((line, index) => (
              <li key={`${line.taskId}-${line.attempt}-${index}`}>
                {formatTime(line.at)} · <span className="mono">{line.taskId}</span>{' '}
                attempt {line.attempt}
                {line.supersedes === null || line.supersedes === undefined
                  ? ' recorded'
                  : ' judged'}
                : {line.outcome ?? 'unjudged'}
                {line.classification === null || line.classification === undefined
                  ? ''
                  : ` (${line.classification})`}
                {line.recordedBy === null || line.recordedBy === undefined
                  ? ''
                  : ` by ${line.recordedBy}`}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </details>
  )
}
