import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ApiError, apiSend } from '../../lib/api'
import { announceChange } from '../../lib/changes'
import { useApi } from '../../lib/useApi'
import { formatBytes, shortHash } from '../../lib/format'
import { ErrorState, Loading } from '../../components/States'
import { AttachmentUpload } from '../../components/AttachmentUpload'
import { ClaudeSettings } from '../../components/ClaudeSettings'
import type {
  AttachmentRecord,
  ClaudeAccountsResponse,
  ClaudeEffort,
  DesignLensList,
  DesignPanelResponse,
  DesignReferenceCatalog,
  GuidancePackList,
  ProjectListResponse,
  RunStatus,
  RunSummary,
} from '../../lib/types'

/**
 * Starting a design panel, in the two steps it actually has.
 *
 * A panel is a normal run first — that is what gives it a project, a plan, a
 * role assignment and a place in history. Only then is its context sealed, and
 * the form says so plainly, because after that point the inputs cannot change.
 */

interface ParticipantDraft {
  accountId: string
  model: string
  effort: ClaudeEffort
  lensId: string
  lens: string
}

const PANEL_CONTEXT_MAX_ATTACHMENT_BYTES = 256 * 1024
const PANEL_CONTEXT_MAX_ARCHIVE_BYTES = 25 * 1024 * 1024

function archiveAttachment(attachment: AttachmentRecord): boolean {
  return attachment.mediaType === 'application/zip'
    || attachment.mediaType === 'application/x-zip-compressed'
    || attachment.originalName.toLowerCase().endsWith('.zip')
}

function attachmentProblem(attachment: AttachmentRecord): string | null {
  if (archiveAttachment(attachment)) {
    return attachment.size > PANEL_CONTEXT_MAX_ARCHIVE_BYTES
      ? 'Not selectable: this archive exceeds the 25 MiB design-panel archive limit.'
      : null
  }
  if (attachment.size > PANEL_CONTEXT_MAX_ATTACHMENT_BYTES) {
    return 'Not selectable: this file exceeds the 256 KiB per-file context limit.'
  }
  return null
}

const OUTPUT_TARGETS = [
  {
    id: 'recommendation',
    label: 'Recommendation only',
    help: 'One reconciled design recommendation as a document. Nothing is built.',
  },
  {
    id: 'prototype',
    label: 'Prototype',
    help: 'Each participant produces a working single-file HTML prototype, and reconciliation produces one more from them. They are stored as artifacts of the run and open from disk — a proposal without one is refused.',
  },
  {
    id: 'design-to-code',
    label: 'Design-to-code handoff',
    help: 'Adds an implementation handoff. It does not authorise a repository write: implementation stays a separate stage behind its own approval.',
  },
] as const

const MODES = [
  {
    id: 'independent',
    label: 'Independent first (recommended)',
    help: 'No participant sees another proposal until every one of them has finished or failed.',
  },
  {
    id: 'collaborative',
    label: 'Collaborative',
    help: 'Participants work in the order listed above. Each is handed the proposals of the ones before it, cannot start until they finish, and the handoff is recorded in the run log.',
  },
] as const

export function DesignPanelForm({ projectId }: { projectId?: string }): JSX.Element {
  const search = new URLSearchParams(window.location.search)
  const [runId, setRunId] = useState<string | null>(search.get('runId'))
  const [project, setProject] = useState(projectId ?? '')
  const [brief, setBrief] = useState('')
  const [orchestrator, setOrchestrator] = useState('work')
  const [orchestratorModel, setOrchestratorModel] = useState('default')
  const [orchestratorEffort, setOrchestratorEffort] = useState<ClaudeEffort>('auto')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [status, setStatus] = useState('')

  const projects = useApi<ProjectListResponse>('/api/projects')
  const accounts = useApi<ClaudeAccountsResponse>('/api/claude/accounts')
  const lenses = useApi<DesignLensList>('/api/design-panel/lenses')
  const references = useApi<DesignReferenceCatalog>('/api/design-panel/references')
  const packs = useApi<GuidancePackList>('/api/design-panel/packs')
  const existingRun = useApi<RunStatus>(
    runId === null ? null : `/api/runs/${encodeURIComponent(runId)}`,
  )
  const attachments = useApi<{ attachments: AttachmentRecord[] }>(
    runId === null ? null : `/api/runs/${encodeURIComponent(runId)}/attachments`,
  )

  const eligible = useMemo(
    () => (accounts.data?.accounts ?? []).filter((account) => account.designPanelEligible),
    [accounts.data],
  )
  const ready = useMemo(
    () => eligible.filter((account) =>
      account.authState === 'authenticated' || account.authState === 'external'),
    [eligible],
  )
  const lensOptions = lenses.data?.lenses ?? []

  const [participants, setParticipants] = useState<ParticipantDraft[]>([])
  const [outputTarget, setOutputTarget] = useState<string>('recommendation')
  const [mode, setMode] = useState<string>('independent')
  const [selectedAttachments, setSelectedAttachments] = useState<string[]>([])
  const [includeProductMd, setIncludeProductMd] = useState(false)
  const [includeDesignMd, setIncludeDesignMd] = useState(false)
  const [primaryReference, setPrimaryReference] = useState('')
  const [secondaryReference, setSecondaryReference] = useState('')
  const [enabledPacks, setEnabledPacks] = useState<Record<string, Record<string, number>>>({})
  const [acknowledgeConflict, setAcknowledgeConflict] = useState(false)
  const [hydratedRunId, setHydratedRunId] = useState<string | null>(null)

  // A run may arrive here from the general new-run form, a recovery link on
  // its detail page, or a browser refresh. Restore the first-step values so
  // continuing setup does not require retyping the brief or project.
  useEffect(() => {
    if (
      runId === null || hydratedRunId === runId || existingRun.data === null
      || existingRun.data.runId !== runId
    ) return
    setBrief((current) => current === '' ? existingRun.data?.requirement?.summary ?? '' : current)
    setProject((current) => current === '' ? existingRun.data?.projectId ?? '' : current)
    setHydratedRunId(runId)
  }, [existingRun.data, hydratedRunId, runId])

  // Prefer accounts that can actually start now. Keep the other eligible
  // identities in the selector so their sign-in state remains visible, but do
  // not strand a panel on a logged-out account by selecting it automatically.
  useEffect(() => {
    if (participants.length > 0 || ready.length === 0 || lensOptions.length === 0) return
    setParticipants(
      ready.slice(0, Math.min(3, Math.max(2, ready.length))).map((account, index) => ({
        accountId: account.id,
        model: 'default',
        effort: 'auto' as ClaudeEffort,
        lensId: lensOptions[index % lensOptions.length]?.id ?? '',
        lens: '',
      })),
    )
  }, [lensOptions, participants.length, ready])

  const conflict = useMemo(() => {
    const on = Object.keys(enabledPacks)
    for (const pack of packs.data?.packs ?? []) {
      if (!on.includes(pack.packId)) continue
      const clash = pack.conflictsWith.find((other) => on.includes(other))
      if (clash !== undefined) return `${pack.label} and ${clash}`
    }
    return null
  }, [enabledPacks, packs.data])

  const createRun = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setStatus('Creating the run…')
    try {
      const body: Record<string, unknown> = {
        orchestrator,
        model: orchestratorModel,
        effort: orchestratorEffort,
        shape: 'design-panel',
        requirement: brief.trim().slice(0, 4000),
      }
      if (project !== '') body.projectId = project
      const created = await apiSend<{ run: RunSummary }>('/api/runs', 'POST', body)
      announceChange()
      setRunId(created.run.runId)
      window.history.replaceState(
        null,
        '',
        `/design-panel/new?runId=${encodeURIComponent(created.run.runId)}`,
      )
      setStatus(`Run ${created.run.runId} created. Choose the panel's inputs and participants.`)
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not reach the local server.'))
      setStatus('The run was not created.')
    } finally {
      setBusy(false)
    }
  }

  const createPanel = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (runId === null) return
    setBusy(true)
    setError(null)
    setStatus('Sealing the shared context…')
    try {
      const referenceIds = [primaryReference, secondaryReference]
        .filter((value) => value !== '')
        .filter((value, index, all) => all.indexOf(value) === index)
      await apiSend<DesignPanelResponse>(
        `/api/runs/${encodeURIComponent(runId)}/design-panel`,
        'POST',
        {
          brief: brief.trim(),
          participants: participants.map((participant) => ({
            accountId: participant.accountId,
            model: participant.model,
            effort: participant.effort,
            lensId: participant.lensId,
            ...(participant.lens.trim() === '' ? {} : { lens: participant.lens.trim() }),
          })),
          mode,
          outputTarget,
          attachmentIds: selectedAttachments,
          includeProductMd,
          includeDesignMd,
          referenceIds,
          packs: enabledPacks,
          acknowledgePackConflict: acknowledgeConflict,
          proposePlan: true,
        },
      )
      announceChange()
      window.history.pushState(null, '', `/runs/${runId}/design-panel`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not reach the local server.'))
      setStatus('The panel was not created. Nothing has been sealed.')
    } finally {
      setBusy(false)
    }
  }

  const setParticipant = (index: number, patch: Partial<ParticipantDraft>): void => {
    setParticipants((current) =>
      current.map((participant, position) =>
        position === index ? { ...participant, ...patch } : participant))
  }

  const togglePack = (packId: string, on: boolean): void => {
    setEnabledPacks((current) => {
      const next = { ...current }
      if (!on) {
        delete next[packId]
        return next
      }
      const pack = (packs.data?.packs ?? []).find((item) => item.packId === packId)
      next[packId] = Object.fromEntries((pack?.dials ?? []).map((dial) => [dial.id, dial.default]))
      return next
    })
  }

  const duplicateAccounts =
    new Set(participants.map((participant) => participant.accountId)).size !== participants.length
  const duplicateLenses =
    new Set(participants.map((participant) => participant.lensId)).size !== participants.length
  const unavailableParticipants = participants.flatMap((participant) => {
    const account = eligible.find((candidate) => candidate.id === participant.accountId)
    return account === undefined || account.authState === 'authenticated' || account.authState === 'external'
      ? []
      : [account]
  })
  const invalidSelectedAttachments = (attachments.data?.attachments ?? [])
    .filter((attachment) => selectedAttachments.includes(attachment.attachmentId))
    .filter((attachment) => attachmentProblem(attachment) !== null)
  const canSubmit =
    runId !== null && participants.length >= 2 && !duplicateAccounts && !duplicateLenses &&
    unavailableParticipants.length === 0 && invalidSelectedAttachments.length === 0 &&
    brief.trim() !== '' &&
    (conflict === null || acknowledgeConflict) && !busy

  return (
    <>
      <h1>Start a design panel</h1>
      <p className="lede">
        Two or three Claude accounts are given the same sealed project context, work
        independently, and are then reconciled into one recommendation. It is a normal FLOW run:
        it appears in the project, it needs your plan and role approval, and every account keeps
        its own credentials.
      </p>

      {error ? <ErrorState error={error} /> : null}
      <p className="visually-hidden" role="status" aria-live="polite">{status}</p>

      <ol className="panel-steps">
        <li aria-current={runId === null ? 'step' : undefined}>
          <span className="badge">{runId === null ? '1 · now' : '1 · done'}</span> Create the run
        </li>
        <li aria-current={runId !== null ? 'step' : undefined}>
          <span className="badge">{runId === null ? '2 · next' : '2 · now'}</span> Seal the context and configure the panel
        </li>
      </ol>

      {runId === null ? (
        <form className="card" onSubmit={(event) => void createRun(event)}>
          <fieldset>
            <legend><strong>The run</strong></legend>
            <p>
              <label htmlFor="panel-project"><strong>Project</strong></label>
              <br />
              <select
                id="panel-project"
                required
                value={project}
                onChange={(event) => setProject(event.target.value)}
              >
                <option value="">choose a project…</option>
                {(projects.data?.projects ?? []).map((option) => (
                  <option key={option.projectId} value={option.projectId}>
                    {option.name ?? option.projectId}
                  </option>
                ))}
              </select>
            </p>
            <p>
              <label htmlFor="panel-brief"><strong>Design brief</strong></label>
              <br />
              <span className="muted" id="panel-brief-help">
                What is being designed, for whom, and what would make it good. Every participant
                gets exactly this text.
              </span>
              <br />
              <textarea
                id="panel-brief"
                aria-describedby="panel-brief-help"
                value={brief}
                rows={6}
                required
                maxLength={20000}
                style={{ width: '100%', maxWidth: 720 }}
                onChange={(event) => setBrief(event.target.value)}
              />
            </p>
          </fieldset>
          <fieldset>
            <legend><strong>Orchestrator</strong></legend>
            <p className="muted" style={{ marginTop: 0 }}>
              The account that holds the run together and, later, reconciles the proposals.
            </p>
            <ClaudeSettings
              accountId={orchestrator}
              model={orchestratorModel}
              effort={orchestratorEffort}
              onAccount={setOrchestrator}
              onModel={setOrchestratorModel}
              onEffort={setOrchestratorEffort}
            />
          </fieldset>
          <div className="stack">
            <button className="action primary" type="submit" disabled={busy || project === '' || brief.trim() === ''}>
              {busy ? 'Creating…' : 'Create the run'}
            </button>
            <a className="action" href={project === '' ? '/projects' : `/projects/${project}`}>Cancel</a>
          </div>
        </form>
      ) : (
        <form className="card" onSubmit={(event) => void createPanel(event)}>
          <p className="banner warn" role="note">
            <strong>The context is sealed when you create the panel.</strong> Attach everything the
            panel should see first — after this, participants receive exactly these bytes and
            nothing else.
          </p>

          <fieldset>
            <legend><strong>Design brief</strong></legend>
            <p style={{ marginTop: 0 }}>
              <label htmlFor="panel-brief-sealed">
                <span className="muted">
                  Every participant receives exactly this text. Edit it here until you seal.
                </span>
              </label>
              <br />
              <textarea
                id="panel-brief-sealed"
                value={brief}
                rows={5}
                required
                maxLength={20000}
                style={{ width: '100%', maxWidth: 720 }}
                onChange={(event) => setBrief(event.target.value)}
              />
            </p>
          </fieldset>

          <fieldset>
            <legend><strong>Shared inputs</strong></legend>
            <p className="muted" style={{ marginTop: 0 }}>
              Selected once, for everyone. No participant is given anything the others are not.
            </p>
            <AttachmentUpload runId={runId} onUploaded={attachments.reload} />
            {attachments.loading ? <Loading label="Listing attachments…" /> : null}
            {(attachments.data?.attachments ?? []).length === 0 ? (
              <p className="muted">Nothing attached yet. A brief on its own is a valid panel.</p>
            ) : (
              <ul className="checklist">
                {(attachments.data?.attachments ?? []).map((attachment) => (
                  <li key={attachment.attachmentId}>
                    <label>
                      <input
                        type="checkbox"
                        disabled={attachmentProblem(attachment) !== null}
                        checked={selectedAttachments.includes(attachment.attachmentId)}
                        onChange={(event) =>
                          setSelectedAttachments((current) =>
                            event.target.checked
                              ? [...current, attachment.attachmentId]
                              : current.filter((id) => id !== attachment.attachmentId))}
                      />{' '}
                      {attachment.originalName}{' '}
                      <span className="muted">
                        {attachment.mediaType} · {formatBytes(attachment.size)} ·{' '}
                        {shortHash(attachment.sha256)}
                      </span>
                    </label>
                    {attachmentProblem(attachment) ? (
                      <div className="muted">{attachmentProblem(attachment)}</div>
                    ) : archiveAttachment(attachment) ? (
                      <div className="muted">Safe HTML, CSS, JavaScript and other text files will be read from the ZIP; binary assets and dependencies are listed but not executed.</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <ul className="checklist">
              <li>
                <label>
                  <input
                    type="checkbox"
                    checked={includeProductMd}
                    onChange={(event) => setIncludeProductMd(event.target.checked)}
                  />{' '}
                  Include the project's <code>PRODUCT.md</code> when it exists
                </label>
              </li>
              <li>
                <label>
                  <input
                    type="checkbox"
                    checked={includeDesignMd}
                    onChange={(event) => setIncludeDesignMd(event.target.checked)}
                  />{' '}
                  Include the project's <code>DESIGN.md</code> when it exists
                </label>
              </li>
            </ul>
          </fieldset>

          <fieldset>
            <legend><strong>Participants</strong></legend>
            {accounts.error ? <ErrorState error={accounts.error} /> : null}
            {ready.length < 2 ? (
              <p className="banner danger" role="alert">
                Fewer than two design-capable Claude identities are signed in and available, so a
                panel cannot be formed yet.
              </p>
            ) : null}
            {unavailableParticipants.map((account) => (
              <p className="banner danger" role="alert" key={`unavailable-${account.id}`}>
                <strong>{account.label} cannot join this panel: </strong>
                {account.authState === 'login_required'
                  ? 'sign in to this Claude identity first.'
                  : 'this Claude identity is unavailable on this machine.'}
              </p>
            ))}
            {duplicateAccounts ? (
              <p className="banner warn" role="alert">
                Each account may take part once. The same account twice is one opinion, not a panel.
              </p>
            ) : null}
            {duplicateLenses ? (
              <p className="banner warn" role="alert">Each participant needs a distinct lens.</p>
            ) : null}
            {participants.map((participant, index) => (
              <div className="card participant-row" key={`participant-${index}`}>
                <div className="form-grid">
                  <label>
                    <strong>Account</strong>
                    <select
                      value={participant.accountId}
                      onChange={(event) => setParticipant(index, {
                        accountId: event.target.value, model: 'default', effort: 'auto',
                      })}
                    >
                      {eligible.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.label}
                          {account.authState === 'login_required' ? ' — sign-in required' : ''}
                          {account.authState === 'unavailable' ? ' — unavailable' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <strong>Model</strong>
                    <select
                      value={participant.model}
                      onChange={(event) => setParticipant(index, { model: event.target.value, effort: 'auto' })}
                    >
                      {(eligible.find((account) => account.id === participant.accountId)?.models ?? [])
                        .map((model) => (
                          <option key={model.id} value={model.id}>{model.label}</option>
                        ))}
                    </select>
                  </label>
                  <label>
                    <strong>Effort</strong>
                    <select
                      value={participant.effort}
                      onChange={(event) => setParticipant(index, { effort: event.target.value as ClaudeEffort })}
                    >
                      {(eligible.find((account) => account.id === participant.accountId)?.models
                        .find((model) => model.id === participant.model)?.efforts ?? ['auto'])
                        .map((option) => (
                          <option key={option} value={option}>
                            {option === 'auto' ? 'Default' : option}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    <strong>Design lens</strong>
                    <select
                      value={participant.lensId}
                      onChange={(event) => setParticipant(index, { lensId: event.target.value, lens: '' })}
                    >
                      {lensOptions.map((lens) => (
                        <option key={lens.id} value={lens.id}>{lens.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <p>
                  <label htmlFor={`lens-text-${index}`}>
                    <span className="muted">
                      Lens brief — edit it to steer this participant. Empty uses the default.
                    </span>
                  </label>
                  <br />
                  <textarea
                    id={`lens-text-${index}`}
                    rows={3}
                    maxLength={4000}
                    style={{ width: '100%' }}
                    placeholder={lensOptions.find((lens) => lens.id === participant.lensId)?.text ?? ''}
                    value={participant.lens}
                    onChange={(event) => setParticipant(index, { lens: event.target.value })}
                  />
                </p>
                {participants.length > 2 ? (
                  <button
                    className="action"
                    type="button"
                    onClick={() => setParticipants((current) =>
                      current.filter((_item, position) => position !== index))}
                  >
                    Remove {participant.accountId}
                  </button>
                ) : null}
              </div>
            ))}
            {participants.length < 3 && eligible.length > participants.length ? (
              <button
                className="action"
                type="button"
                onClick={() => setParticipants((current) => {
                  const account = eligible.find((item) =>
                    !current.some((participant) => participant.accountId === item.id))
                  const lens = lensOptions.find((item) =>
                    !current.some((participant) => participant.lensId === item.id))
                  if (account === undefined) return current
                  return [...current, {
                    accountId: account.id, model: 'default', effort: 'auto' as ClaudeEffort,
                    lensId: lens?.id ?? lensOptions[0]?.id ?? '', lens: '',
                  }]
                })}
              >
                Add a third participant
              </button>
            ) : null}
          </fieldset>

          <fieldset>
            <legend><strong>What the panel produces</strong></legend>
            {OUTPUT_TARGETS.map((option) => (
              <p key={option.id} style={{ margin: '6px 0' }}>
                <label>
                  <input
                    type="radio"
                    name="output-target"
                    value={option.id}
                    checked={outputTarget === option.id}
                    onChange={() => setOutputTarget(option.id)}
                  />{' '}
                  <strong>{option.label}</strong>
                  <br />
                  <span className="muted">{option.help}</span>
                </label>
              </p>
            ))}
          </fieldset>

          <fieldset>
            <legend><strong>How they work</strong></legend>
            {MODES.map((option) => (
              <p key={option.id} style={{ margin: '6px 0' }}>
                <label>
                  <input
                    type="radio"
                    name="panel-mode"
                    value={option.id}
                    checked={mode === option.id}
                    onChange={() => setMode(option.id)}
                  />{' '}
                  <strong>{option.label}</strong>
                  <br />
                  <span className="muted">{option.help}</span>
                </label>
              </p>
            ))}
          </fieldset>

          <fieldset>
            <legend><strong>Design-language reference</strong> <span className="muted">optional</span></legend>
            {references.data?.available === false ? (
              <p className="muted">No reference catalog is vendored on this machine.</p>
            ) : (
              <>
                <p className="muted" style={{ marginTop: 0 }}>
                  {references.data?.warning ??
                    'References are inspiration for an original direction, not authorisation to impersonate a brand.'}
                </p>
                <div className="form-grid">
                  <label>
                    <strong>Primary</strong>
                    <select value={primaryReference} onChange={(event) => setPrimaryReference(event.target.value)}>
                      <option value="">none</option>
                      {(references.data?.entries ?? []).map((entry) => (
                        <option key={entry.id} value={entry.id}>{entry.id}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <strong>Secondary</strong>
                    <select
                      value={secondaryReference}
                      disabled={primaryReference === ''}
                      onChange={(event) => setSecondaryReference(event.target.value)}
                    >
                      <option value="">none</option>
                      {(references.data?.entries ?? [])
                        .filter((entry) => entry.id !== primaryReference)
                        .map((entry) => (
                          <option key={entry.id} value={entry.id}>{entry.id}</option>
                        ))}
                    </select>
                  </label>
                </div>
                {primaryReference !== '' ? (
                  <p className="muted">
                    {(references.data?.entries ?? []).find((entry) => entry.id === primaryReference)?.description}
                    <br />
                    Source {references.data?.source} at {shortHash(references.data?.commit ?? null)} ({references.data?.license})
                  </p>
                ) : null}
              </>
            )}
          </fieldset>

          <fieldset>
            <legend><strong>Guidance packs</strong> <span className="muted">optional</span></legend>
            {(packs.data?.packs ?? []).length === 0 ? (
              <p className="muted">No guidance packs are vendored on this machine.</p>
            ) : null}
            {(packs.data?.packs ?? []).map((pack) => {
              const on = Object.prototype.hasOwnProperty.call(enabledPacks, pack.packId)
              return (
                <div className="card" key={pack.packId}>
                  <label>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(event) => togglePack(pack.packId, event.target.checked)}
                    />{' '}
                    <strong>{pack.label}</strong>{' '}
                    <span className="badge">{pack.license}</span>{' '}
                    {pack.stability === 'experimental'
                      ? <span className="badge warn">experimental upstream</span>
                      : null}
                  </label>
                  <ul className="muted">
                    {pack.changes.map((change) => <li key={change}>{change}</li>)}
                  </ul>
                  {pack.stabilityNote ? <p className="muted">{pack.stabilityNote}</p> : null}
                  {pack.detector?.enabledByDefault === false ? (
                    <p className="muted">
                      Its executable detector stays off. Enabling one would download an engine
                      binary and install editor hooks, which is a separate, explicit decision — and
                      no hook can bypass this toolkit's approvals.
                    </p>
                  ) : null}
                  {on && pack.dials.length > 0 ? (
                    <div className="form-grid">
                      {pack.dials.map((dial) => (
                        <label key={dial.id}>
                          <strong>{dial.label}</strong>
                          <input
                            type="number"
                            min={dial.min}
                            max={dial.max}
                            step={1}
                            value={enabledPacks[pack.packId]?.[dial.id] ?? dial.default}
                            aria-describedby={`dial-help-${pack.packId}-${dial.id}`}
                            onChange={(event) => setEnabledPacks((current) => ({
                              ...current,
                              [pack.packId]: {
                                ...current[pack.packId],
                                [dial.id]: Number(event.target.value),
                              },
                            }))}
                          />
                          <span className="muted" id={`dial-help-${pack.packId}-${dial.id}`}>
                            {dial.help}
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })}
            {conflict !== null ? (
              <div className="banner warn" role="alert">
                <strong>{conflict} give conflicting stylistic direction.</strong>
                <p style={{ margin: '6px 0 0' }}>
                  Turn one off, or enable both deliberately — the panel is told they disagree, and
                  neither overrides accessibility, the brief or the existing design system.
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={acknowledgeConflict}
                    onChange={(event) => setAcknowledgeConflict(event.target.checked)}
                  />{' '}
                  Enable both anyway
                </label>
              </div>
            ) : null}
          </fieldset>

          <div className="stack">
            <button className="action primary" type="submit" disabled={!canSubmit}>
              {busy ? 'Sealing…' : 'Seal context and create the panel'}
            </button>
            <a className="action" href={`/runs/${runId}`}>Open the run instead</a>
          </div>
          <p className="muted">
            Creating the panel proposes the plan and selects the designers. It approves nothing:
            you still type <code>APPROVE PLAN {runId}</code> in the run session before any account
            starts work.
          </p>
        </form>
      )}
    </>
  )
}
