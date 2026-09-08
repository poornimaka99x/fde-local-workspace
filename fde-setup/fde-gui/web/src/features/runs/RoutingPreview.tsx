import { useEffect, useRef, useState } from 'react'
import { ApiError, apiSend } from '../../lib/api'
import type { ClaudeAccount, RoutingPreviewResponse, RoutingDecision } from '../../lib/types'
import {
  AssessmentDetails,
  bandTone,
  Ceiling,
  confidenceTone,
  CostUnits,
  WhyThisChoice,
} from './RoutingExplanation'

/**
 * The routing preview on the new-run form.
 *
 * It answers one question — "what would this be routed to, and why" — and it
 * answers nothing else. It creates no run, approves nothing, and never submits
 * the form: the operator reads it and decides. The request is debounced so
 * typing a sentence does not become a request per keystroke, and it waits until
 * there is enough of the request to assess rather than showing a
 * confident-looking answer to three words.
 */

const DEBOUNCE_MS = 600

export function RoutingPreview({
  orchestrator,
  strategy,
  requirement,
  shape,
  projectId,
  minChars,
  account,
  enabled,
}: {
  orchestrator: string
  strategy: string
  requirement: string
  shape: string
  projectId: string
  minChars: number
  account: ClaudeAccount | null
  enabled: boolean
}): JSX.Element | null {
  const [preview, setPreview] = useState<RoutingDecision | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(false)
  const sequence = useRef(0)

  const trimmed = requirement.trim()
  const tooShort = trimmed.length < minChars
  // The account's provider, not its id: a console with several Codex accounts
  // registered gives them registry keys, so comparing against the literal
  // 'codex' matched nothing and a preview was requested for a run that cannot
  // have one.
  const codexLed = account?.provider === 'codex'
  const loginNeeded = account !== null
    && account.authState !== 'authenticated'
    && account.authState !== 'external'

  useEffect(() => {
    if (!enabled || tooShort || codexLed || loginNeeded) {
      setPreview(null)
      setError(null)
      setLoading(false)
      return
    }
    const ticket = sequence.current + 1
    sequence.current = ticket
    setLoading(true)
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const body: Record<string, unknown> = { orchestrator, strategy, requirement: trimmed }
          if (shape.trim() !== '') body.shape = shape.trim()
          if (projectId !== '') body.projectId = projectId
          const answer = await apiSend<RoutingPreviewResponse>(
            '/api/routing/preview', 'POST', body)
          if (sequence.current !== ticket) return
          setPreview(answer.preview)
          setError(null)
        } catch (cause) {
          if (sequence.current !== ticket) return
          setPreview(null)
          setError(cause instanceof ApiError
            ? cause
            : new ApiError(0, 'network', 'Could not reach the local server for a preview.'))
        } finally {
          if (sequence.current === ticket) setLoading(false)
        }
      })()
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [enabled, tooShort, codexLed, orchestrator, strategy, trimmed, shape, projectId, loginNeeded])

  if (!enabled) return null

  if (codexLed) {
    return (
      <p className="banner warn" role="status">
        A Codex-led run is driven from its own Codex task. The controller will still record a
        route for it, but this console cannot preview one.
      </p>
    )
  }

  if (loginNeeded) {
    return (
      <p className="banner warn" role="status">
        Sign in to <strong>{account?.label ?? orchestrator}</strong> before routing this run.
        Automatic routing will not substitute a different account for one that cannot be
        reached.
      </p>
    )
  }

  if (tooShort) {
    return (
      <p className="muted" role="status">
        Say a little more about what you want done and this will show the model, the effort and
        the estimated cost it would choose — {minChars - trimmed.length} more character
        {minChars - trimmed.length === 1 ? '' : 's'} to go.
      </p>
    )
  }

  return (
    <div aria-live="polite" aria-busy={loading}>
      {loading && preview === null ? (
        <p className="muted" role="status">Working out the route…</p>
      ) : null}
      {error !== null ? (
        <p className="banner warn" role="status">
          <strong>No preview: </strong>
          {error.message}
          {error.detail ? <> {error.detail}</> : null}
        </p>
      ) : null}
      {preview !== null ? <PreviewBody preview={preview} loading={loading} /> : null}
    </div>
  )
}

function PreviewBody({ preview, loading }: {
  preview: RoutingDecision
  loading: boolean
}): JSX.Element {
  const { assessment, orchestrator } = preview
  return (
    <div className="card">
      <div className="stack" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>What this would be routed to</strong>
        {loading ? <span className="muted">refreshing…</span> : null}
      </div>

      <div className="stack" style={{ flexWrap: 'wrap' }}>
        <span className={`badge ${bandTone(assessment.band)}`}>
          complexity: {assessment.band}
        </span>
        <span className="muted">
          {assessment.score}/{assessment.maxScore}
        </span>
        <span className={`badge ${confidenceTone(assessment.confidence)}`}>
          confidence: {assessment.confidence}
        </span>
        <span className="badge">floor: {assessment.qualityFloor}</span>
      </div>

      <table>
        <tbody>
          <tr>
            <th scope="row">Model and effort</th>
            <td>
              {orchestrator.routable ? (
                <span className="mono">
                  {orchestrator.model} / {orchestrator.effort}
                </span>
              ) : (
                <span className="muted">no model to select — {orchestrator.reason}</span>
              )}
            </td>
          </tr>
          <tr>
            <th scope="row">Estimated cost</th>
            <td>
              <CostUnits value={preview.estimatedCostUnits} />{' '}
              <span className="muted">
                relative units from the routing policy, not money
              </span>
            </td>
          </tr>
          <tr>
            <th scope="row">Escalation ceiling</th>
            <td><Ceiling ceiling={orchestrator.escalationCeiling} /></td>
          </tr>
          <tr>
            <th scope="row">Policy</th>
            <td className="mono">{preview.policyRevision}</td>
          </tr>
        </tbody>
      </table>

      {assessment.clarification ? (
        <p className="banner warn" role="status">
          <strong>Worth answering first: </strong>
          {assessment.clarification}
        </p>
      ) : null}

      {preview.warnings.map((warning) => (
        <p className="banner warn" key={warning} role="status">{warning}</p>
      ))}

      <WhyThisChoice
        reason={orchestrator.reason}
        strategyRule={orchestrator.strategyRule}
        alternatives={orchestrator.alternatives}
        rejected={orchestrator.rejected}
        limitations={orchestrator.limitations}
      />
      <AssessmentDetails assessment={assessment} />

      <p className="muted" style={{ marginBottom: 0 }}>
        {preview.provisional === true
          ? preview.provisionalReason
            ?? 'The specialist matrix is provisional until the plan and roles are recorded.'
          : null}{' '}
        Nothing has been created or approved. The plan, the roles and this route are approved
        together, in the conversation, with the exact phrase.
      </p>
    </div>
  )
}
