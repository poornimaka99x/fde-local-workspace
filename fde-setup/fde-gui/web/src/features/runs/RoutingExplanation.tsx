import type {
  RoutingAssessment,
  RoutingChoice,
  RoutingEscalationCeiling,
  RoutingRejection,
  RoutingUsage,
  RoutingUsageValue,
} from '../../lib/types'

/**
 * The pieces of routing that both the new-run preview and the run view need to
 * show, written once.
 *
 * Two rules run through all of it. Nothing is explained by colour alone: every
 * badge carries its own words, so a reader who cannot see the tone still gets
 * the whole answer. And every explanation is a real `<details>`, which is
 * keyboard-operable and screen-reader-addressable without any of our help.
 */

export function bandTone(band: string | null | undefined): string {
  if (band === 'critical') return 'danger'
  if (band === 'complex') return 'warn'
  return 'ok'
}

export function confidenceTone(confidence: string | null | undefined): string {
  if (confidence === 'low') return 'danger'
  if (confidence === 'medium') return 'warn'
  return 'ok'
}

/** A cost figure, always labelled as the estimate it is. */
export function CostUnits({ value, prefix = '~' }: {
  value: number | null | undefined
  prefix?: string
}): JSX.Element {
  if (typeof value !== 'number') return <span className="muted">not estimated</span>
  return (
    <span title="A relative estimate from the routing policy's cost weights. Not money.">
      {prefix}
      {Number.isInteger(value) ? value : value.toFixed(1)} units
    </span>
  )
}

/**
 * One telemetry figure, rendered by its provenance.
 *
 * An unavailable measurement says "unavailable" and why. It never renders as 0:
 * a missing number shown as zero is a lie that reads like data.
 */
export function UsageFigure({ label, figure }: {
  label: string
  figure: RoutingUsageValue | undefined
}): JSX.Element {
  if (figure === undefined || figure.state === 'unavailable') {
    return (
      <div>
        <span className="muted">{label}</span>{' '}
        <span className="badge">unavailable</span>{' '}
        <span className="muted">{figure?.reason ?? 'not reported'}</span>
      </div>
    )
  }
  return (
    <div>
      <span className="muted">{label}</span>{' '}
      <strong>{String(figure.value)}</strong>{' '}
      <span className="badge">{figure.state}</span>{' '}
      {figure.source ? <span className="muted">{figure.source}</span> : null}
    </div>
  )
}

const USAGE_LABELS: [string, string][] = [
  ['inputTokens', 'Input tokens'],
  ['outputTokens', 'Output tokens'],
  ['cacheReadTokens', 'Cache read tokens'],
  ['cacheWriteTokens', 'Cache write tokens'],
  ['totalTokens', 'Total tokens'],
  ['durationMs', 'Duration (ms)'],
  ['monetaryCost', 'Reported cost'],
  ['estimatedCostUnits', 'Estimated cost units'],
  ['attempts', 'Attempts'],
  ['retries', 'Retries'],
  ['escalations', 'Escalations'],
]

export function UsageBlock({ usage }: { usage: RoutingUsage | undefined }): JSX.Element {
  const figures = usage ?? {}
  return (
    <div className="card">
      <strong>Usage</strong>
      <p className="muted" style={{ marginTop: 0 }}>
        Every figure is marked as reported by a provider, estimated by the controller, or
        unavailable. Nothing here is inferred, and a missing measurement is never shown as
        zero.
      </p>
      {USAGE_LABELS.filter(([key]) => figures[key] !== undefined).map(([key, label]) => (
        <UsageFigure key={key} label={label} figure={figures[key]} />
      ))}
      {USAGE_LABELS.every(([key]) => figures[key] === undefined) ? (
        <p className="muted" style={{ marginBottom: 0 }}>
          No usage has been recorded for this run yet.
        </p>
      ) : null}
    </div>
  )
}

export function Ceiling({ ceiling }: {
  ceiling: RoutingEscalationCeiling | null | undefined
}): JSX.Element {
  if (!ceiling?.tier) return <span className="muted">no ceiling recorded</span>
  return (
    <span>
      up to <span className="mono">{ceiling.tier}</span> tier at{' '}
      <span className="mono">{ceiling.effort}</span> effort,{' '}
      {typeof ceiling.maxRetries === 'number'
        ? `${ceiling.maxRetries} retry max`
        : 'retry count not recorded'}
    </span>
  )
}

/**
 * Why this choice, and why not the others.
 *
 * A `<details>` rather than a tooltip or a hover card: the operator is being
 * asked to approve a spend, and the reasoning has to be reachable by keyboard
 * and readable by a screen reader, not only visible to a mouse.
 */
export function WhyThisChoice({
  reason,
  strategyRule,
  alternatives,
  rejected,
  limitations,
  id,
}: {
  reason: string | null | undefined
  strategyRule?: string | null
  alternatives?: RoutingChoice[]
  rejected?: RoutingRejection[]
  limitations?: string[]
  id?: string
}): JSX.Element {
  return (
    <details className="card" id={id}>
      <summary>Why this choice?</summary>
      <p>{reason ?? 'The controller recorded no reason for this choice.'}</p>
      {strategyRule ? (
        <p className="muted">
          <strong>Rule applied:</strong> {strategyRule}
        </p>
      ) : null}
      {limitations && limitations.length > 0 ? (
        <>
          <strong>Known limitations of this model</strong>
          <ul>
            {limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
      {alternatives && alternatives.length > 0 ? (
        <>
          <strong>Alternatives considered</strong>
          <ul>
            {alternatives.map((choice) => (
              <li key={`${choice.model}-${choice.effort}`}>
                <span className="mono">
                  {choice.model}/{choice.effort}
                </span>{' '}
                <span className="muted">
                  {choice.tier} tier, <CostUnits value={choice.expectedCostUnits} /> expected
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {rejected && rejected.length > 0 ? (
        <>
          <strong>Refused, and why</strong>
          <ul>
            {rejected.map((choice) => (
              <li key={`${choice.model}-${choice.effort}`}>
                <span className="mono">
                  {choice.model}/{choice.effort}
                </span>{' '}
                — {choice.reason}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </details>
  )
}

/** The assessment, dimension by dimension, with the evidence for each score. */
export function AssessmentDetails({ assessment }: {
  assessment: RoutingAssessment
}): JSX.Element {
  return (
    <details className="card">
      <summary>
        How this was assessed — {assessment.score}/{assessment.maxScore}, band{' '}
        {assessment.band}
      </summary>
      <p className="muted">
        Scored from the request, the stage slice, attachment metadata and this project&rsquo;s
        recorded repositories. Nothing connected was read.
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Dimension</th>
            <th scope="col">Score</th>
            <th scope="col">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {assessment.dimensions.map((dimension) => (
            <tr key={dimension.id}>
              <th scope="row">{dimension.label}</th>
              <td className="mono">{dimension.score}/2</td>
              <td>{dimension.evidence}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {assessment.riskFlags.length > 0 ? (
        <>
          <strong>Risk</strong>
          <ul>
            {assessment.riskFlags.map((flag) => (
              <li key={flag.flag}>
                <span className="mono">{flag.flag}</span>
                {flag.floor ? <> → {flag.floor} floor</> : null} — {flag.evidence}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {assessment.overrides.length > 0 ? (
        <>
          <strong>What moved the band</strong>
          <ul>
            {assessment.overrides.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </>
      ) : null}
      {assessment.missingInformation.length > 0 ? (
        <>
          <strong>Missing information that could change the route</strong>
          <ul>
            {assessment.missingInformation.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
    </details>
  )
}
