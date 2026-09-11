import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from '../../lib/router'
import { ApiError, apiSend } from '../../lib/api'
import { announceChange } from '../../lib/changes'
import { formatTime, stateTone } from '../../lib/format'
import { useApi } from '../../lib/useApi'
import type {
  ClaudeAccountsResponse,
  FdeRunRegistration,
  FdeSystemConfiguration,
  ProjectListResponse,
  RunSummary,
  SystemTypeDefinition,
} from '../../lib/types'
import { EmptyState, ErrorState, Loading, Warnings } from '../../components/States'
import { RunDetail } from '../runs/RunDetail'

interface ConfigurationsResponse { schemaVersion: 1; configurations: FdeSystemConfiguration[] }
interface SystemTypesResponse { schemaVersion: 1; systemTypes: SystemTypeDefinition[] }
interface FdeRunsResponse {
  schemaVersion: 1
  runs: { registration: FdeRunRegistration; run: RunSummary | null }[]
  total: number
  warnings: string[]
}

function go(to: string): void {
  window.history.pushState(null, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function SystemsView(): JSX.Element {
  const systems = useApi<SystemTypesResponse>('/api/system-types')
  const configurations = useApi<ConfigurationsResponse>('/api/system-configurations')
  const runs = useApi<FdeRunsResponse>('/api/fde-runs')
  const fde = systems.data?.systemTypes.find((system) => system.id === 'forward-deployed-engineer')
  return <>
    <p className="eyebrow">Executable systems</p>
    <h1>Systems</h1>
    <p className="lede">Choose a governed system, configure how it works, and start a separately tracked run.</p>
    {systems.error ? <ErrorState error={systems.error} onRetry={systems.reload} /> : null}
    {systems.loading && systems.data === null ? <Loading label="Loading systems…" /> : null}
    {fde ? <article className="card system-card">
      <div>
        <div className="stack"><span className="badge ok">available</span><span className="badge">dedicated executor</span></div>
        <h2>{fde.name}</h2>
        <p>{fde.description}</p>
        <p className="system-flow">Business intent → analysis → requirements → architecture → planning → implementation → QA → documentation → deployment → operations</p>
        <p className="muted">Human approval and independent review remain part of the controller lifecycle.</p>
      </div>
      <dl className="system-stats">
        <div><dt>Configurations</dt><dd>{configurations.data?.configurations.length ?? '…'}</dd></div>
        <div><dt>FDE runs</dt><dd>{runs.data?.total ?? '…'}</dd></div>
        <div><dt>Stages</dt><dd>{fde.lifecycle.length}</dd></div>
      </dl>
      <div className="stack">
        <Link className="action primary" to="/systems/forward-deployed-engineer/new">Start run</Link>
        <Link className="action" to="/systems/forward-deployed-engineer">Configure</Link>
        <Link className="action" to="/systems/forward-deployed-engineer/runs">View runs</Link>
      </div>
    </article> : null}
  </>
}

export function FdeSystemView(): JSX.Element {
  const configurations = useApi<ConfigurationsResponse>('/api/system-configurations')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setSaving(true); setError(null)
    try {
      const response = await apiSend<{ configuration: FdeSystemConfiguration }>('/api/system-configurations', 'POST', { name })
      announceChange(); go(`/systems/forward-deployed-engineer/configurations/${response.configuration.id}`)
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not create the configuration.'))
    } finally { setSaving(false) }
  }
  return <>
    <p><Link to="/systems">Systems</Link> / Forward Deployed Engineer</p>
    <div className="stack system-heading">
      <div><p className="eyebrow">System configuration</p><h1>Forward Deployed Engineer</h1>
        <p className="lede">Reusable execution profiles for the complete human-governed delivery lifecycle.</p></div>
      <Link className="action primary" to="/systems/forward-deployed-engineer/new">Start FDE run</Link>
      <Link className="action" to="/systems/forward-deployed-engineer/runs">Run history</Link>
    </div>
    {configurations.error ? <ErrorState error={configurations.error} onRetry={configurations.reload} /> : null}
    {error ? <ErrorState error={error} /> : null}
    <div className="grid">
      {(configurations.data?.configurations ?? []).map((configuration) => <article className="card" key={configuration.id}>
        <div className="stack"><span className={`badge ${configuration.enabled ? 'ok' : 'warn'}`}>{configuration.enabled ? 'active' : 'disabled'}</span><span className="badge">v{configuration.version}</span></div>
        <h2>{configuration.name}</h2><p>{configuration.description}</p>
        <p className="muted">{configuration.stages.filter((stage) => stage.enabled).length} of {configuration.stages.length} stages enabled · executor: {configuration.executorType}</p>
        <div className="stack">
          <Link className="action" to={`/systems/forward-deployed-engineer/configurations/${configuration.id}`}>Configure</Link>
          <Link className="action primary" to={`/systems/forward-deployed-engineer/new?configurationId=${configuration.id}`}>Start run</Link>
        </div>
      </article>)}
    </div>
    <form className="card stack" onSubmit={(event) => void create(event)}>
      <label><strong>New configuration</strong><br/><input value={name} minLength={3} maxLength={120} required placeholder="Azure Enterprise FDE" onChange={(event) => setName(event.target.value)} /></label>
      <button className="action" disabled={saving || name.trim().length < 3}>{saving ? 'Creating…' : 'Create configuration'}</button>
    </form>
  </>
}

export function FdeConfigurationView({ configurationId }: { configurationId: string }): JSX.Element {
  const source = useApi<{ configuration: FdeSystemConfiguration }>(`/api/system-configurations/${encodeURIComponent(configurationId)}`)
  const accounts = useApi<ClaudeAccountsResponse>('/api/claude/accounts')
  const [value, setValue] = useState<FdeSystemConfiguration | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  useEffect(() => { if (source.data) setValue(source.data.configuration) }, [source.data])
  const candidates = (accounts.data?.accounts ?? []).filter((account) => account.orchestratorEligible !== false)
  const update = (changes: Partial<FdeSystemConfiguration>): void => setValue((current) => current ? { ...current, ...changes } : current)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); if (!value) return; setSaving(true); setError(null); setMessage(null)
    try {
      const response = await apiSend<{ configuration: FdeSystemConfiguration }>(`/api/system-configurations/${encodeURIComponent(value.id)}`, 'PUT', value)
      setValue(response.configuration); setMessage(`Saved version ${response.configuration.version}.`); announceChange()
    } catch (cause) { setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not save the configuration.')) }
    finally { setSaving(false) }
  }
  if (source.error) return <ErrorState error={source.error} onRetry={source.reload} />
  if (!value) return <Loading label="Loading FDE configuration…" />
  return <>
    <p><Link to="/systems">Systems</Link> / <Link to="/systems/forward-deployed-engineer">Forward Deployed Engineer</Link> / Configuration</p>
    <p className="eyebrow">Dedicated executor profile</p><h1>{value.name}</h1>
    <p className="lede">Configure the lifecycle. Capability-level inherit/enable/disable controls remain available in the capability catalog.</p>
    {error ? <ErrorState error={error} /> : null}{message ? <p className="banner" role="status">{message}</p> : null}
    <form onSubmit={(event) => void submit(event)}>
      <section className="card"><h2>General</h2><div className="form-grid">
        <label>Name<input value={value.name} required minLength={3} onChange={(event) => update({ name: event.target.value })}/></label>
        <label>Default orchestrator<select value={value.orchestrator} onChange={(event) => update({ orchestrator: event.target.value })}>{candidates.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label>
        <label>Repository<input value={value.repository ?? ''} placeholder="optional absolute path" onChange={(event) => update({ repository: event.target.value || null })}/></label>
        <label>Artifact root<input value={value.artifactRoot} onChange={(event) => update({ artifactRoot: event.target.value })}/></label>
        <label>Routing<select value={value.routing} onChange={(event) => update({ routing: event.target.value as 'auto' | 'manual' })}><option value="auto">Automatic</option><option value="manual">Manual</option></select></label>
        <label>Strategy<select value={value.strategy} onChange={(event) => update({ strategy: event.target.value as FdeSystemConfiguration['strategy'] })}><option value="balanced">Balanced</option><option value="quality_first">Quality first</option><option value="cost_first">Cost first</option></select></label>
      </div><label><input type="checkbox" checked={value.enabled} onChange={(event) => update({ enabled: event.target.checked })}/> Configuration enabled</label></section>
      <section><div className="stack system-heading"><div><h2>Lifecycle</h2><p className="muted">Primary delivery, independent review, then human approval at each enabled stage.</p></div><Link className="action" to="/configuration">Configure skills, agents, MCPs, tools and plugins</Link></div>
        <ol className="fde-stage-list">{value.stages.map((stage, index) => <li className="card" key={stage.id}>
          <div className="stage-number">{index + 1}</div><div className="stage-config"><div className="stack"><h3>{stage.label}</h3><span className="badge ok">approval required</span></div>
          <div className="form-grid"><label><span>Primary account</span><select value={stage.primaryAccount ?? ''} onChange={(event) => update({ stages: value.stages.map((item) => item.id === stage.id ? { ...item, primaryAccount: event.target.value || null } : item) })}><option value="">inherit orchestrator</option>{candidates.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label>
          <label><span>Reviewer account</span><select value={stage.reviewerAccount ?? ''} onChange={(event) => update({ stages: value.stages.map((item) => item.id === stage.id ? { ...item, reviewerAccount: event.target.value || null } : item) })}><option value="">select during run</option>{(accounts.data?.accounts ?? []).map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label></div>
          <label><input type="checkbox" checked={stage.enabled} onChange={(event) => update({ stages: value.stages.map((item) => item.id === stage.id ? { ...item, enabled: event.target.checked } : item) })}/> Stage enabled</label></div>
        </li>)}</ol>
      </section>
      <section className="card"><h2>Human governance</h2><p>These controls are enforced and cannot be switched off in this configuration.</p><ul><li>Approval after every stage</li><li>Approval before code changes</li><li>Approval before deployment</li><li>Approval before production mutation</li><li>Stop and ask when material ambiguity is found</li></ul></section>
      <div className="stack"><button className="action primary" disabled={saving}>{saving ? 'Saving…' : 'Save configuration'}</button><Link className="action" to={`/systems/forward-deployed-engineer/new?configurationId=${value.id}`}>Start run</Link><Link className="action" to="/systems/forward-deployed-engineer">Back</Link></div>
    </form>
  </>
}

export function NewFdeRunForm({ initialConfigurationId }: { initialConfigurationId?: string }): JSX.Element {
  const configurations = useApi<ConfigurationsResponse>('/api/system-configurations')
  const projects = useApi<ProjectListResponse>('/api/projects')
  const accounts = useApi<ClaudeAccountsResponse>('/api/claude/accounts')
  const [configurationId, setConfigurationId] = useState(initialConfigurationId ?? 'default-forward-deployed-engineer')
  const [projectId, setProjectId] = useState('')
  const [orchestrator, setOrchestrator] = useState('')
  const [businessIntent, setBusinessIntent] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const configuration = configurations.data?.configurations.find((item) => item.id === configurationId) ?? null
  useEffect(() => { if (configuration && orchestrator === '') setOrchestrator(configuration.orchestrator) }, [configuration, orchestrator])
  const start = async (): Promise<void> => {
    setSaving(true); setError(null)
    try {
      const response = await apiSend<{ run: RunSummary }>('/api/fde-runs', 'POST', { configurationId, projectId: projectId || undefined, orchestrator: orchestrator || undefined, businessIntent })
      announceChange(); go(`/systems/forward-deployed-engineer/runs/${response.run.runId}`)
    } catch (cause) { setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not start the FDE run.')) }
    finally { setSaving(false) }
  }
  const enabledStages = configuration?.stages.filter((stage) => stage.enabled) ?? []
  return <>
    <p><Link to="/systems">Systems</Link> / <Link to="/systems/forward-deployed-engineer">Forward Deployed Engineer</Link> / New run</p>
    <p className="eyebrow">Dedicated executor</p><h1>Start Forward Deployed Engineer Run</h1>
    <p className="lede">Create a separately tracked lifecycle run from business intent through operations.</p>
    {error ? <ErrorState error={error} /> : null}
    {!reviewing ? <form className="card" onSubmit={(event) => { event.preventDefault(); setReviewing(true) }}>
      <div className="form-grid"><label>Configuration<select value={configurationId} onChange={(event) => setConfigurationId(event.target.value)}>{(configurations.data?.configurations ?? []).filter((item) => item.enabled).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Project<select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">none (unassigned)</option>{(projects.data?.projects ?? []).map((project) => <option key={project.projectId} value={project.projectId}>{project.name ?? project.projectId}</option>)}</select></label>
      <label>Orchestrator<select value={orchestrator} onChange={(event) => setOrchestrator(event.target.value)}>{(accounts.data?.accounts ?? []).filter((account) => account.orchestratorEligible !== false).map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label></div>
      <label><strong>Business intent</strong><br/><textarea rows={8} required minLength={8} maxLength={12000} value={businessIntent} placeholder="Describe the business outcome, affected users, constraints, and known context." onChange={(event) => setBusinessIntent(event.target.value)}/></label>
      <div className="stack"><button className="action primary" disabled={!configuration || businessIntent.trim().length < 8 || !orchestrator}>Review run</button><Link className="action" to="/systems/forward-deployed-engineer">Cancel</Link></div>
    </form> : <section className="card"><p className="eyebrow">Review before starting</p><h2>{configuration?.name}</h2><p>{businessIntent}</p>
      <dl className="kv"><dt>Executor</dt><dd>forward-deployed-engineer</dd><dt>Orchestrator</dt><dd>{accounts.data?.accounts.find((item) => item.id === orchestrator)?.label ?? orchestrator}</dd><dt>Stages</dt><dd>{enabledStages.length}</dd><dt>Human gates</dt><dd>Every stage, code changes, deployment and production mutation</dd></dl>
      <ol className="timeline">{enabledStages.map((stage) => <li key={stage.id}><span className="dot"/><span>{stage.label}</span><span className="muted">primary → independent review → approval</span></li>)}</ol>
      <p className="banner warn">Starting creates a governed controller run. It does not approve access, implementation, deployment, or publication.</p>
      <div className="stack"><button className="action primary" disabled={saving} onClick={() => void start()}>{saving ? 'Starting…' : 'Start Forward Deployed Engineer Run'}</button><button className="action" disabled={saving} onClick={() => setReviewing(false)}>Back</button></div>
    </section>}
  </>
}

export function FdeRunsView(): JSX.Element {
  const result = useApi<FdeRunsResponse>('/api/fde-runs', 20000)
  return <>
    <div className="stack system-heading"><div><p className="eyebrow">Separate run history</p><h1>Forward Deployed Engineer Runs</h1><p className="lede">Only runs created through the dedicated FDE executor appear here.</p></div><Link className="action primary" to="/systems/forward-deployed-engineer/new">Start run</Link></div>
    {result.error ? <ErrorState error={result.error} onRetry={result.reload}/> : null}
    {result.loading && result.data === null ? <Loading label="Loading FDE runs…"/> : null}<Warnings warnings={result.data?.warnings ?? []}/>
    {result.data?.runs.length === 0 ? <EmptyState title="No FDE system runs yet">Start one from a Forward Deployed Engineer configuration.</EmptyState> : null}
    {result.data && result.data.runs.length > 0 ? <div className="card table-scroll"><table><thead><tr><th>Run</th><th>Business intent</th><th>Configuration</th><th>State</th><th>Created</th></tr></thead><tbody>{result.data.runs.map(({ registration, run }) => <tr key={registration.runId}><td><Link to={`/systems/forward-deployed-engineer/runs/${registration.runId}`}>{registration.runId}</Link></td><td>{registration.businessIntent}</td><td>{registration.configurationSnapshot.name} <span className="muted">v{registration.configurationVersion}</span></td><td><span className={`badge ${stateTone(run?.state ?? null)}`}>{run?.state ?? 'controller record unavailable'}</span></td><td className="muted">{formatTime(registration.createdAt)}</td></tr>)}</tbody></table></div> : null}
  </>
}

export function FdeRunDetail({ runId }: { runId: string }): JSX.Element {
  const record = useApi<{ registration: FdeRunRegistration }>(`/api/fde-runs/${encodeURIComponent(runId)}`)
  return <>
    <div className="banner"><strong>Forward Deployed Engineer run</strong>{record.data ? <> · {record.data.registration.configurationSnapshot.name} v{record.data.registration.configurationVersion}</> : null}<div><Link to="/systems/forward-deployed-engineer/runs">Back to FDE run history</Link></div></div>
    <RunDetail runId={runId}/>
  </>
}
