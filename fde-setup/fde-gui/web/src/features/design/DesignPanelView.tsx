import { useEffect, useRef, useState } from 'react'
import { Link } from '../../lib/router'
import { ApiError, apiGetText, apiSend, fileContentUrl } from '../../lib/api'
import { announceChange } from '../../lib/changes'
import { useApi } from '../../lib/useApi'
import { formatBytes, formatTime, shortHash } from '../../lib/format'
import { ErrorState, Loading } from '../../components/States'
import { Markdown } from '../../components/Markdown'
import type { DesignPanel, DesignPanelResponse, PanelParticipant } from '../../lib/types'

/**
 * The design panel as the controller reports it.
 *
 * Nothing on this page decides anything: it starts, stops and retries the work
 * the controller says is startable, and shows the record. Plan approval, role
 * approval and the degraded-reconciliation approval are typed by the operator
 * in a terminal, and this page says so rather than offering a button.
 */

/** State is never carried by colour alone: a mark and a word travel together. */
const STATE_MARK: Record<string, { mark: string; tone: string; label: string }> = {
  pending: { mark: '◻', tone: '', label: 'not started' },
  running: { mark: '▸', tone: 'warn', label: 'running' },
  succeeded: { mark: '✓', tone: 'ok', label: 'proposal in' },
  failed: { mark: '✕', tone: 'danger', label: 'failed' },
  stopped: { mark: '■', tone: 'warn', label: 'stopped' },
  interrupted: { mark: '⚠', tone: 'warn', label: 'interrupted' },
}

function StateBadge({ state }: { state: string }): JSX.Element {
  const entry = STATE_MARK[state] ?? { mark: '·', tone: '', label: state }
  return (
    <span className={`badge ${entry.tone}`}>
      <span aria-hidden="true">{entry.mark}</span> {entry.label}
    </span>
  )
}

function duration(participant: PanelParticipant): string {
  if (participant.durationMs === null || participant.durationMs === undefined) return '—'
  const seconds = Math.round(participant.durationMs / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

function ArtifactDocument({
  runId,
  path,
  title,
  open,
}: {
  runId: string
  path: string
  title: string
  open?: boolean
}): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const requested = useRef(false)

  const load = (): void => {
    if (requested.current) return
    requested.current = true
    setLoading(true)
    apiGetText(fileContentUrl(runId, path, 'inline'))
      .then((result) => setText(result.truncated ? `${result.text}\n\n_(truncated preview)_` : result.text))
      .catch(() => setError('That artifact could not be read.'))
      .finally(() => setLoading(false))
  }

  // A section that starts open never fires a toggle, so it would otherwise sit
  // empty until the reader closed and reopened it.
  useEffect(() => {
    if (open === true) load()
  })

  return (
    <details className="card" open={open} onToggle={load}>
      <summary>
        <strong>{title}</strong> <span className="muted mono">{path}</span>
      </summary>
      {loading ? <Loading label="Reading…" /> : null}
      {error !== null ? <p className="banner danger" role="alert">{error}</p> : null}
      {text !== null ? <Markdown source={text} /> : null}
    </details>
  )
}

export function DesignPanelView({ runId }: { runId: string }): JSX.Element {
  const panel = useApi<DesignPanelResponse>(`/api/runs/${encodeURIComponent(runId)}/design-panel`)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<ApiError | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const previous = useRef<Record<string, string>>({})

  const data = panel.data?.designPanel ?? null
  const working = data !== null && (
    data.participants.some((participant) => participant.state === 'running') ||
    String(data.reconciliation.state ?? '') === 'running')

  // While work is in flight the page follows it; when nothing is running it
  // stops polling rather than asking a local controller every few seconds.
  const reload = panel.reload
  useEffect(() => {
    if (!working) return
    const timer = window.setInterval(() => {
      if (!document.hidden) reload()
    }, 4000)
    return () => window.clearInterval(timer)
  }, [working, reload])

  // Status changes are announced, not just recoloured.
  useEffect(() => {
    if (data === null) return
    const changes: string[] = []
    for (const participant of data.participants) {
      const before = previous.current[participant.participantId]
      if (before !== undefined && before !== participant.state) {
        changes.push(`${participant.label} is now ${STATE_MARK[participant.state]?.label ?? participant.state}`)
      }
      previous.current[participant.participantId] = participant.state
    }
    if (changes.length > 0) setAnnouncement(changes.join('. '))
  }, [data])

  if (panel.error) {
    return (
      <>
        <p className="muted">
          <Link to={`/runs/${runId}`}>{runId}</Link> / design panel
        </p>
        <ErrorState error={panel.error} onRetry={panel.reload} />
      </>
    )
  }
  if (data === null) return <Loading label="Loading design panel…" />

  const act = async (path: string, label: string): Promise<void> => {
    setBusy(label)
    setActionError(null)
    try {
      await apiSend<DesignPanelResponse>(path, 'POST')
      announceChange()
      setAnnouncement(`${label} accepted.`)
      panel.reload()
    } catch (cause) {
      setActionError(cause instanceof ApiError
        ? cause
        : new ApiError(0, 'network', 'Could not reach the local server.'))
    } finally {
      setBusy(null)
    }
  }

  const manifest = data.contextManifest
  const reconciliationState = String(data.reconciliation.state ?? 'pending')
  const canReconcile =
    data.rolesConfirmed && data.reconcileStageReady && data.state === 'awaiting_reconciliation' &&
    (data.succeededCount >= 2 || (data.succeededCount === 1 && data.degradedApprovedAt !== null))

  return (
    <>
      <p className="muted">
        <Link to="/projects">Projects</Link> /{' '}
        {data.projectId ? <Link to={`/projects/${data.projectId}`}>{data.projectId}</Link> : 'unassigned'} /{' '}
        <Link to={`/runs/${data.runId}`}>{data.runId}</Link> / design panel
      </p>

      <div className="stack" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>Design panel</h1>
          <p className="lede">{data.brief}</p>
        </div>
        <div className="stack">
          <span className="badge">{data.panelId}</span>
          <span className={`badge ${data.state === 'complete' ? 'ok' : ''}`}>
            <span aria-hidden="true">{data.state === 'complete' ? '✓' : '·'}</span> {data.state.replace(/_/g, ' ')}
          </span>
          <span className="badge">{data.mode === 'independent' ? 'independent first' : 'collaborative'}</span>
          <span className="badge">{data.outputTarget}</span>
          <button className="action" type="button" onClick={panel.reload}>Refresh</button>
        </div>
      </div>

      <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
      {actionError ? <ErrorState error={actionError} /> : null}

      <div className="card">
        <strong>Next</strong>
        <div className="mono">{data.nextAction}</div>
      </div>

      {!data.rolesConfirmed ? (
        <div className="banner warn" role="note">
          <strong>This panel is waiting for your approval.</strong>
          <p style={{ margin: '6px 0 0' }}>
            {data.pendingRoles.length > 0
              ? `Assign the roles this plan still needs (${data.pendingRoles.join(', ')}) in the run session, then type:`
              : 'In the run session, type:'}{' '}
            <code>APPROVE PLAN {data.runId}</code>
          </p>
          <p style={{ margin: '6px 0 0' }}>
            The console has no button for it, and no participant can start until it is typed.
          </p>
        </div>
      ) : null}

      <h2>Shared context</h2>
      <div className="card table-scroll">
        <table>
          <tbody>
            <tr>
              <th scope="row">Context SHA-256</th>
              <td className="mono" title={data.context.contextSha256 ?? ''}>
                {shortHash(data.context.contextSha256 ?? null, 24)}
                {' '}<span className="muted">({formatBytes(data.context.commonContextBytes ?? null)}, identical for every participant)</span>
              </td>
            </tr>
            <tr>
              <th scope="row">Manifest SHA-256</th>
              <td className="mono" title={data.context.manifestSha256 ?? ''}>
                {shortHash(data.context.manifestSha256 ?? null, 24)}
              </td>
            </tr>
            {(manifest?.repositories ?? []).length > 0 ? (
              <tr>
                <th scope="row">Repositories</th>
                <td>
                  {(manifest?.repositories ?? []).map((repository) => (
                    <div key={repository.path} className="mono" style={{ fontSize: 12 }}>
                      {repository.path} — {repository.head ? shortHash(repository.head) : 'not a git repository'}
                    </div>
                  ))}
                </td>
              </tr>
            ) : null}
            {(manifest?.inputFiles ?? []).length > 0 ? (
              <tr>
                <th scope="row">Inputs</th>
                <td>
                  {(manifest?.inputFiles ?? []).map((input) => (
                    <div key={input.attachmentId}>
                      {input.originalName}{' '}
                      <span className="muted mono" style={{ fontSize: 12 }}>
                        {input.mediaType} · {formatBytes(input.bytes)} · {shortHash(input.sha256)} ·{' '}
                        {input.passthrough === 'file' ? 'passed as a file' : 'inlined'}
                        {input.truncated ? ' · truncated' : ''}
                      </span>
                    </div>
                  ))}
                </td>
              </tr>
            ) : null}
            {(manifest?.designReferences ?? []).length > 0 ? (
              <tr>
                <th scope="row">Design references</th>
                <td>
                  {(manifest?.designReferences ?? []).map((reference) => (
                    <div key={reference.referenceId}>
                      {reference.role}: {reference.name}{' '}
                      <span className="muted mono" style={{ fontSize: 12 }}>
                        {reference.license} · {shortHash(reference.commit)} · {shortHash(reference.sha256)}
                      </span>
                    </div>
                  ))}
                  <p className="muted" style={{ margin: '4px 0 0' }}>
                    Inspiration, not authorisation to impersonate a brand or reuse its assets.
                  </p>
                </td>
              </tr>
            ) : null}
            {(manifest?.guidancePacks ?? []).length > 0 ? (
              <tr>
                <th scope="row">Guidance packs</th>
                <td>
                  {(manifest?.guidancePacks ?? []).map((pack) => (
                    <div key={pack.packId}>
                      {pack.packId}{' '}
                      <span className="muted mono" style={{ fontSize: 12 }}>
                        {pack.license} · {shortHash(pack.commit)} · {pack.stability}
                        {Object.keys(pack.options).length > 0
                          ? ` · ${Object.entries(pack.options).map(([key, value]) => `${key} ${value}`).join(', ')}`
                          : ''}
                      </span>
                      {pack.documents.filter((document) => document.truncated).map((document) => (
                        <div className="muted" key={document.path} style={{ fontSize: 12 }}>
                          {document.document}: {formatBytes(document.includedBytes)} of{' '}
                          {formatBytes(document.totalBytes)} used
                        </div>
                      ))}
                    </div>
                  ))}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <p className="muted" style={{ marginBottom: 0 }}>
          The manifest and the exact shared bytes are artifacts of this run:{' '}
          <span className="mono">artifacts/design-panel/</span>.
        </p>
      </div>

      <h2>Participants</h2>
      <div className="grid">
        {data.participants.map((participant) => {
          const canStart = data.rolesConfirmed && data.conceptStageReady && participant.state === 'pending'
          const canStop = participant.state === 'running'
          const canRetry = ['failed', 'stopped', 'interrupted'].includes(participant.state)
          const base = `/api/runs/${encodeURIComponent(data.runId)}/design-panel/participants/${encodeURIComponent(participant.participantId)}`
          return (
            <section className="card" key={participant.participantId} aria-label={`${participant.label} — ${participant.state}`}>
              <div className="stack" style={{ justifyContent: 'space-between' }}>
                <strong>{participant.label}</strong>
                <StateBadge state={participant.state} />
              </div>
              <p className="muted" style={{ margin: '4px 0' }}>
                {participant.lensLabel}
              </p>
              <table className="participant-facts">
                <tbody>
                  <tr><th scope="row">Model</th><td>{participant.model} · {participant.effort}</td></tr>
                  <tr><th scope="row">Attempts</th><td>{participant.attempts}</td></tr>
                  <tr><th scope="row">Duration</th><td>{duration(participant)}</td></tr>
                  <tr>
                    <th scope="row">Shared context</th>
                    <td className="mono" title={participant.commonContextSha256 ?? ''}>
                      {shortHash(participant.commonContextSha256)}
                    </td>
                  </tr>
                </tbody>
              </table>
              {participant.error ? (
                <p className="banner danger" role="note" style={{ marginTop: 8 }}>{participant.error}</p>
              ) : null}
              <div className="stack">
                <button
                  // Primary only while it is actually the thing to do: a
                  // disabled primary button still shouts.
                  className={canStart ? 'action primary' : 'action'}
                  type="button"
                  disabled={!canStart || busy !== null}
                  onClick={() => void act(`${base}/start`, `Start ${participant.label}`)}
                >
                  {busy === `Start ${participant.label}` ? 'Starting…' : 'Start'}
                </button>
                <button
                  className="action"
                  type="button"
                  disabled={!canStop || busy !== null}
                  onClick={() => void act(`${base}/stop`, `Stop ${participant.label}`)}
                >
                  Stop
                </button>
                <button
                  className="action"
                  type="button"
                  disabled={!canRetry || busy !== null}
                  onClick={() => void act(`${base}/retry`, `Retry ${participant.label}`)}
                >
                  Retry
                </button>
              </div>
              {participant.proposalPresent && participant.proposalPath !== null ? (
                <ArtifactDocument
                  runId={data.runId}
                  path={participant.proposalPath}
                  title={`Proposal — ${participant.label}`}
                />
              ) : (
                <p className="muted" style={{ marginBottom: 0 }}>No proposal recorded yet.</p>
              )}
            </section>
          )
        })}
      </div>

      {!data.conceptStageReady && data.rolesConfirmed && data.state !== 'complete' ? (
        <p className="banner warn" role="note">
          The run is in <code>{data.runState}</code>. Participants work the solutioning stage —
          advance the run in its session, or with <code>fde resume {data.runId} --next</code>.
        </p>
      ) : null}

      <h2>Comparison and reconciliation</h2>
      <div className="card">
        <p style={{ marginTop: 0 }}>
          {data.succeededCount} of {data.participants.length} proposals succeeded.{' '}
          {data.barrierOpenedAt === null
            ? 'The information barrier is closed: no participant has seen another proposal.'
            : `The barrier opened at ${formatTime(data.barrierOpenedAt)}, for reconciliation.`}
        </p>
        {data.succeededCount === 1 && data.degradedApprovedAt === null ? (
          <div className="banner warn" role="note">
            <strong>Only one proposal succeeded.</strong>
            <p style={{ margin: '6px 0 0' }}>
              Retry a participant, or approve reconciling on one proposal — which you type in a
              terminal, because a recommendation nothing argued with is a decision, not a default:
            </p>
            <pre style={{ marginTop: 6 }}>fde design-panel approve-degraded {data.runId}</pre>
          </div>
        ) : null}
        <p className="muted">
          The comparison covers {data.comparisonDimensions.join(', ')}.
        </p>
        {data.reconciliation.error ? (
          <p className="banner danger" role="note">{String(data.reconciliation.error)}</p>
        ) : null}
        <div className="stack">
          <button
            className="action primary"
            type="button"
            disabled={!canReconcile || busy !== null || reconciliationState === 'running'}
            onClick={() => void act(
              `/api/runs/${encodeURIComponent(data.runId)}/design-panel/reconcile`, 'Reconcile')}
          >
            {reconciliationState === 'running' ? 'Reconciling…' : 'Reconcile the panel'}
          </button>
          <span className="badge">
            <span aria-hidden="true">{reconciliationState === 'complete' ? '✓' : '·'}</span>{' '}
            reconciliation {reconciliationState}
          </span>
        </div>
      </div>

      {data.artifacts
        .filter((artifact) => artifact.present && !artifact.path.endsWith('context-manifest.json')
          && !artifact.path.endsWith('common-context.md'))
        .map((artifact) => (
          <ArtifactDocument
            key={artifact.path}
            runId={data.runId}
            path={artifact.path}
            title={artifact.path.split('/').pop() ?? artifact.path}
            open={artifact.path.endsWith('final-design.md')}
          />
        ))}

      <h2>Where this lives</h2>
      <div className="card">
        <ul>
          <li><Link to={`/runs/${data.runId}`}>The run</Link> — plan, roles, approvals and events</li>
          {data.projectId ? (
            <li><Link to={`/projects/${data.projectId}`}>The project</Link> — every run under it</li>
          ) : null}
          <li>
            <span className="mono">artifacts/design-panel/</span> — the sealed context, one
            proposal per participant, the comparison, the reconciliation and the final design
          </li>
        </ul>
      </div>
    </>
  )
}
