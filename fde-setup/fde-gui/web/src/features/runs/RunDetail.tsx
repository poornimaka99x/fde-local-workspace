import { useEffect, useMemo, useState } from 'react'
import { Link } from '../../lib/router'
import { formatBytes, formatTime, shortHash, stateTone } from '../../lib/format'
import { useApi } from '../../lib/useApi'
import { ApiError, apiGet, apiSend } from '../../lib/api'
import { announceChange } from '../../lib/changes'
import type { EventPage, FileListResponse, RunStatus } from '../../lib/types'
import { AttachmentUpload } from '../../components/AttachmentUpload'
import { SessionPanel } from './SessionPanel'
import { RoutingMatrix } from './RoutingMatrix'
import { FileBrowser } from '../../components/FileBrowser'
import { ErrorState, Loading, Warnings } from '../../components/States'
import { Tabs } from '../../components/Tabs'

const TAB_IDS = ['overview', 'session', 'routing', 'inputs', 'artifacts', 'events', 'approvals'] as const
type TabId = (typeof TAB_IDS)[number]

export function RunDetail({ runId }: { runId: string }): JSX.Element {
  const autoStart = new URLSearchParams(window.location.search).get('startSession') === '1'
  const requestedTab = new URLSearchParams(window.location.search).get('tab')
  const initialTab: TabId = autoStart
    ? 'session'
    : TAB_IDS.includes(requestedTab as TabId) ? requestedTab as TabId : 'overview'
  const [tab, setTab] = useState<TabId>(initialTab)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<ApiError | null>(null)
  const status = useApi<RunStatus>(`/api/runs/${encodeURIComponent(runId)}`, 20000)
  const files = useApi<FileListResponse>(`/api/runs/${encodeURIComponent(runId)}/files`)

  // RunDetail stays mounted when the lightweight router moves directly from
  // one run to another, so honor the destination link's requested tab rather
  // than carrying the previous run's local tab state across.
  useEffect(() => setTab(initialTab), [runId, requestedTab, autoStart])

  if (status.error) return <ErrorState error={status.error} onRetry={status.reload} />
  if (status.data === null) return <Loading label="Loading run…" />
  const run = status.data

  const inputFiles = (files.data?.entries ?? []).filter((entry) => entry.path.startsWith('inputs/'))
  const artifactFiles = (files.data?.entries ?? []).filter((entry) => entry.path.startsWith('artifacts/'))
  const unfinishedDesignPanel = run.designPanel === null
    && run.plan?.source === 'shape'
    && run.plan?.intent === '--shape design-panel'

  const deleteRun = async (): Promise<void> => {
    if (!window.confirm(
      `Delete run “${run.runId}”? Its complete record, attachments, and artifacts will move to recoverable trash. Repositories and project metadata are not deleted.`,
    )) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await apiSend(`/api/runs/${encodeURIComponent(run.runId)}`, 'DELETE')
      announceChange()
      window.history.pushState(null, '', '/runs')
      window.dispatchEvent(new PopStateEvent('popstate'))
    } catch (cause) {
      setDeleteError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not delete this run.'))
      setDeleting(false)
    }
  }

  return (
    <>
      <p className="muted">
        <Link to="/runs">Runs</Link> /{' '}
        {run.projectId ? <Link to={`/projects/${run.projectId}`}>{run.projectId}</Link> : 'unassigned'} /{' '}
        {run.runId}
      </p>

      <div className="stack" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>{run.runId}</h1>
          <p className="lede">{run.requirement.summary ?? 'No requirement stated yet.'}</p>
        </div>
        <div className="stack">
          <span className={`badge ${stateTone(run.state)}`}>{run.state ?? 'unknown'}</span>
          {run.blockedFrom ? <span className="badge danger">blocked from {run.blockedFrom}</span> : null}
          <button className="action" type="button" onClick={status.reload}>
            Refresh
          </button>
          <button className="action danger" type="button" disabled={deleting} onClick={() => void deleteRun()}>
            {deleting ? 'Deleting…' : 'Delete run'}
          </button>
        </div>
      </div>

      {deleteError ? <ErrorState error={deleteError} /> : null}
      <Warnings warnings={run.warnings} />

      {run.designPanel?.panelId ? (
        <div className="card">
          <div className="stack" style={{ justifyContent: 'space-between' }}>
            <span>
              <strong>This run is a design panel.</strong>{' '}
              <span className="muted">
                {run.designPanel.succeededCount ?? 0} of{' '}
                {run.designPanel.participants?.length ?? 0} proposals in ·{' '}
                {(run.designPanel.state ?? 'unknown').replace(/_/g, ' ')}
              </span>
            </span>
            <Link className="action primary" to={`/runs/${run.runId}/design-panel`}>
              Open the design panel
            </Link>
          </div>
        </div>
      ) : null}

      {unfinishedDesignPanel ? (
        <div className="card banner warn">
          <div className="stack" style={{ justifyContent: 'space-between' }}>
            <span>
              <strong>This design panel has not been configured yet.</strong>{' '}
              <span className="muted">
                The run was created, but its shared context and participants were not sealed.
              </span>
            </span>
            <Link
              className="action primary"
              to={`/design-panel/new?runId=${encodeURIComponent(run.runId)}`}
            >
              Finish setting up the design panel
            </Link>
          </div>
        </div>
      ) : null}

      <div className="card">
        <strong>Next</strong>
        <div className="mono">{run.nextAction ?? 'nothing recorded'}</div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Use the Session tab to work with the orchestrator. Plan approval and every later approval
          remain explicit choices in that conversation.
        </p>
      </div>

      <Tabs
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'session', label: 'Session' },
          {
            id: 'routing',
            label: 'Routing',
            badge: run.routing?.taskCount ?? undefined,
          },
          { id: 'inputs', label: 'Inputs', badge: run.attachments.length },
          { id: 'artifacts', label: 'Artifacts', badge: artifactFiles.length },
          { id: 'events', label: 'Events', badge: run.events.total },
          { id: 'approvals', label: 'Approvals & evidence', badge: run.approvals.length },
        ]}
        active={tab}
        onSelect={(id) => setTab(id as TabId)}
      />

      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={-1}>
        {tab === 'overview' ? <Overview run={run} /> : null}
        {tab === 'session' ? (
          <SessionPanel run={run} autoStart={autoStart} onRunChanged={status.reload} />
        ) : null}
        {tab === 'routing' ? <RoutingMatrix run={run} /> : null}
        {tab === 'inputs' ? (
          <Inputs
            run={run}
            entries={inputFiles}
            loading={files.loading}
            onChanged={() => {
              status.reload()
              files.reload()
            }}
          />
        ) : null}
        {tab === 'artifacts' ? (
          <Artifacts run={run} entries={artifactFiles} withheld={files.data?.withheld ?? []} />
        ) : null}
        {tab === 'events' ? <Events runId={run.runId} first={run.events} /> : null}
        {tab === 'approvals' ? <Approvals run={run} /> : null}
      </div>
    </>
  )
}

function Overview({ run }: { run: RunStatus }): JSX.Element {
  return (
    <>
      <h2>Plan</h2>
      {run.plan === null ? (
        <p className="muted">This run has not been scoped yet.</p>
      ) : (
        <div className="card">
          <ul className="timeline">
            {run.stageTimeline.map((step) => (
              <li key={step.stage} className={step.state}>
                <span className="dot" />
                <span>{step.label}</span>
                {step.state === 'current' ? <span className="badge">now</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h2>Roles</h2>
      <div className="card table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Assigned identity</th>
            </tr>
          </thead>
          <tbody>
            {run.roles.assignments.map((row) => (
              <tr key={row.role}>
                <th scope="row">
                  {row.label} <span className="muted mono">{row.role}</span>
                  {row.optional ? <span className="badge" style={{ marginLeft: 6 }}>optional</span> : null}
                </th>
                <td>
                  {row.assignees.length === 0 ? (
                    <span className="muted">none</span>
                  ) : (
                    row.assignees.map((who) => (
                      <div key={who.agentId}>
                        {who.label} <span className="muted mono">{who.agentId}</span>
                      </div>
                    ))
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ marginBottom: 0 }}>
          {run.roles.confirmed
            ? `Confirmed ${formatTime(run.roles.confirmedAt)}`
            : 'Not confirmed — the run may not read connected systems yet.'}
        </p>
      </div>

      <h2>Manifest</h2>
      <details className="card">
        <summary>Raw manifest.json</summary>
        <pre style={{ marginTop: 8 }}>{JSON.stringify(run.manifest, null, 2)}</pre>
      </details>
    </>
  )
}

function Inputs({
  run,
  entries,
  loading,
  onChanged,
}: {
  run: RunStatus
  entries: FileListResponse['entries']
  loading: boolean
  onChanged: () => void
}): JSX.Element {
  return (
    <>
      <AttachmentUpload runId={run.runId} onUploaded={onChanged} />
      <h2>Attachments</h2>
      {run.attachments.length === 0 ? (
        <p className="muted">
          Nothing attached yet. Use the picker above, or{' '}
          <code>fde attach {run.runId} &lt;file&gt;</code> from a terminal.
        </p>
      ) : (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Size</th>
                <th scope="col">SHA-256</th>
                <th scope="col">Attached</th>
              </tr>
            </thead>
            <tbody>
              {run.attachments.map((attachment) => (
                <tr key={attachment.attachmentId}>
                  <td>
                    {attachment.originalName}
                    <div className="muted mono" style={{ fontSize: 12 }}>{attachment.relativePath}</div>
                  </td>
                  <td>{attachment.mediaType}</td>
                  <td>{formatBytes(attachment.size)}</td>
                  <td className="mono" title={attachment.sha256}>{shortHash(attachment.sha256)}</td>
                  <td className="muted">{formatTime(attachment.attachedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Input files</h2>
      {loading ? <Loading label="Listing files…" /> : (
        <FileBrowser runId={run.runId} entries={entries} emptyLabel="This run has no input files." />
      )}
    </>
  )
}

function Artifacts({
  run,
  entries,
  withheld,
}: {
  run: RunStatus
  entries: FileListResponse['entries']
  withheld: string[]
}): JSX.Element {
  return (
    <>
      <h2>Expected by the plan</h2>
      {run.artifacts.expected.length === 0 ? (
        <p className="muted">This plan requires no file artifacts.</p>
      ) : (
        <div className="card">
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {run.artifacts.expected.map((artifact) => (
              <li key={`${artifact.stage}-${artifact.path}`} className="stack" style={{ padding: '4px 0' }}>
                <span className={`badge ${artifact.found ? 'ok' : ''}`}>
                  {artifact.found ? 'present' : 'not yet'}
                </span>
                <span className="mono">{artifact.path}</span>
                <span className="muted">{artifact.stage}</span>
              </li>
            ))}
          </ul>
          <p className="muted" style={{ marginBottom: 0 }}>
            A present file is not a finished stage. The controller's state is the only claim of
            progress.
          </p>
        </div>
      )}

      <h2>Files</h2>
      <FileBrowser runId={run.runId} entries={entries} emptyLabel="No artifacts written yet." />
      {withheld.length > 0 ? (
        <p className="muted" style={{ marginTop: 12 }}>
          {withheld.length} path(s) are deliberately not served by the console — the approval ledger,
          the session id and run-scoped connector configuration. Approvals appear under Approvals
          &amp; evidence.
        </p>
      ) : null}
    </>
  )
}

function Events({ runId, first }: { runId: string; first: EventPage }): JSX.Element {
  const [pages, setPages] = useState<EventPage[]>([first])
  const [busy, setBusy] = useState(false)
  const oldestOffset = useMemo(() => Math.min(...pages.map((page) => page.offset)), [pages])
  const items = useMemo(
    () =>
      [...pages]
        .sort((a, b) => a.offset - b.offset)
        .flatMap((page) => page.items),
    [pages],
  )

  const loadOlder = async (): Promise<void> => {
    if (oldestOffset <= 0) return
    setBusy(true)
    try {
      const limit = Math.min(50, oldestOffset)
      const cursor = Math.max(0, oldestOffset - limit)
      const response = await apiGet<{ events: EventPage }>(
        `/api/runs/${encodeURIComponent(runId)}/events?cursor=${cursor}&limit=${limit}`,
      )
      setPages((current) => [...current, response.events])
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2>
        Events <span className="muted">({first.total} recorded)</span>
      </h2>
      {oldestOffset > 0 ? (
        <button className="action" type="button" onClick={() => void loadOlder()} disabled={busy}>
          {busy ? 'Loading…' : `Load older (${oldestOffset} before this page)`}
        </button>
      ) : (
        <p className="muted">This is the whole log.</p>
      )}
      <div className="card">
        <ul className="timeline">
          {items.map((event, index) => (
            <li key={`${String(event.at)}-${index}`} style={{ display: 'block' }}>
              <div className="stack">
                <span className="mono muted">{String(event.at ?? '')}</span>
                <strong>{String(event.event ?? 'event')}</strong>
                <span className="muted">
                  {String(event.to ?? event.agent ?? event.target ?? event.note ?? '')}
                </span>
              </div>
              <details>
                <summary>raw</summary>
                <pre style={{ marginTop: 6 }}>{JSON.stringify(event, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

function Approvals({ run }: { run: RunStatus }): JSX.Element {
  const hygiene = run.outputHygiene
  return (
    <>
      <h2>Approvals</h2>
      {run.approvals.length === 0 ? (
        <p className="muted">Nothing has been approved on this run.</p>
      ) : (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Approval</th>
                <th scope="col">What</th>
                <th scope="col">Status</th>
                <th scope="col">Issued</th>
                <th scope="col">Expires</th>
                <th scope="col">Bound to</th>
              </tr>
            </thead>
            <tbody>
              {run.approvals.map((approval) => (
                <tr key={approval.approvalId}>
                  <td className="mono">{approval.approvalId}</td>
                  <td>
                    {approval.type === 'codex-approval' ? 'Codex write' : 'Publication'}
                    <div className="muted">{approval.stage ?? approval.target ?? ''}</div>
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        approval.status === 'valid' ? 'ok' : approval.status === 'revoked' ? 'danger' : 'warn'
                      }`}
                    >
                      {approval.status}
                    </span>
                  </td>
                  <td className="muted">{formatTime(approval.issuedAt)}</td>
                  <td className="muted">{formatTime(approval.expiresAt)}</td>
                  <td className="muted mono" style={{ fontSize: 12 }}>
                    {approval.taskFileHash ? <div>task {shortHash(approval.taskFileHash)}</div> : null}
                    {approval.repositoryPath ? <div>{approval.repositoryPath}</div> : null}
                    {approval.summary ? <div>{approval.summary}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ marginBottom: 0 }}>
            Read-only by design. Approvals are typed by you, in a terminal, every time — this console
            offers no way to grant, extend or reuse one.
          </p>
        </div>
      )}

      <h2>Checkpoints</h2>
      {run.checkpoints.length === 0 ? (
        <p className="muted">No stage checkpoints recorded.</p>
      ) : (
        <div className="card">
          <ul className="timeline">
            {run.checkpoints.map((checkpoint, index) => (
              <li key={`${String(checkpoint.checkpointId)}-${index}`} style={{ display: 'block' }}>
                <div className="stack">
                  <span className="mono muted">{String(checkpoint.at ?? '')}</span>
                  <strong>{String(checkpoint.stage ?? '')}</strong>
                  <span className={`badge ${checkpoint.status === 'pass' ? 'ok' : 'warn'}`}>
                    {String(checkpoint.status ?? '')}
                  </span>
                </div>
                <details>
                  <summary>evidence</summary>
                  <pre style={{ marginTop: 6 }}>{JSON.stringify(checkpoint.evidence ?? [], null, 2)}</pre>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h2>Output hygiene</h2>
      {hygiene === null ? (
        <p className="muted">
          Pending. Hygiene runs automatically before publication or completion, and writes hashed
          evidence into the run.
        </p>
      ) : (
        <div className="card">
          <div className="stack">
            <span className={`badge ${hygiene.status === 'completed' ? 'ok' : 'danger'}`}>{hygiene.status}</span>
            <span>{formatTime(hygiene.at)}</span>
            <span className="muted">mode {hygiene.mode}</span>
          </div>
          <table style={{ marginTop: 8 }}>
            <tbody>
              <tr>
                <th scope="row">Files inspected</th>
                <td>{hygiene.files ?? 0}</td>
              </tr>
              <tr>
                <th scope="row">Files changed</th>
                <td>{hygiene.changedFiles ?? 0}</td>
              </tr>
              <tr>
                <th scope="row">Provenance</th>
                <td>
                  {hygiene.provenancePreserved
                    ? 'preserved — watermarks, C2PA/content credentials and creator fields untouched'
                    : 'not preserved'}
                </td>
              </tr>
              <tr>
                <th scope="row">Evidence</th>
                <td className="mono">
                  {hygiene.evidencePath ?? '—'}{' '}
                  {hygiene.evidencePresent ? null : <span className="badge warn">file missing</span>}
                </td>
              </tr>
              <tr>
                <th scope="row">Evidence digest</th>
                <td className="mono" title={hygiene.evidenceSha256 ?? ''}>
                  {shortHash(hygiene.evidenceSha256)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
