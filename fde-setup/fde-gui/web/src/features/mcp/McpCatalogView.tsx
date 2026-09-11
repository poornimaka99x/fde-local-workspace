import { useState, type FormEvent } from 'react'
import { ApiError, apiSend } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { EmptyState, ErrorState, Loading } from '../../components/States'
import {
  MCP_STATE_LABEL, mcpScopeSummary, mcpStateClass,
  type McpDetailResponse, type McpField, type McpGatewayResponse,
  type McpListResponse, type McpServer,
} from './types'

function visibleFields(server: McpServer, values: Record<string, string>): McpField[] {
  return server.requiredFields.filter((field) =>
    field.type !== 'generated' &&
    (!field.showWhen || values[field.showWhen.field] === field.showWhen.equals))
}

function StateBadge({ server }: { server: McpServer }): JSX.Element {
  return <span className={`badge ${mcpStateClass(server.state)}`}>
    {MCP_STATE_LABEL[server.state]}
  </span>
}

function SecretRow({ server, field, reload }: {
  server: McpServer, field: McpField, reload: () => void
}): JSX.Element {
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const present = server.credentialsPresent[field.name] === true
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true); setError(null)
    try {
      await apiSend<McpDetailResponse>(
        `/api/mcp/servers/${encodeURIComponent(server.name)}/secret/${encodeURIComponent(field.name)}`,
        'POST', { secret })
      setSecret(''); reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'The credential could not be stored.'))
    } finally { setBusy(false) }
  }
  return <form className="secret-row" onSubmit={(event) => void save(event)}>
    <label><span>{present ? `Replace ${field.label}` : field.label}</span>
      <input type="password" autoComplete="off" spellCheck={false} value={secret}
        placeholder={present ? 'stored — enter a new value to replace it' : field.placeholder ?? ''}
        onChange={(event) => setSecret(event.target.value)} /></label>
    <button className="action" disabled={busy || secret.length < 8}>
      {present ? 'Replace' : 'Store securely'}
    </button>
    {error ? <ErrorState error={error} /> : null}
  </form>
}

function ServerCard({ server, reload }: { server: McpServer, reload: () => void }): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>(server.values)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [open, setOpen] = useState(false)
  const secrets = server.requiredFields.filter((field) => field.secret)
  const act = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label); setError(null)
    try { await fn(); reload() } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'That did not work.'))
    } finally { setBusy(null) }
  }
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    await act('save', async () => apiSend<McpDetailResponse>(
      `/api/mcp/servers/${encodeURIComponent(server.name)}/configure`, 'POST', { values }))
  }
  const fields = visibleFields(server, values)

  return <article className="connection-card" data-server={server.name}>
    <div className="connection-card-head">
      <div>
        <p className="eyebrow">{server.classification} · {server.transport}</p>
        <h3>{server.name}</h3>
      </div>
      <StateBadge server={server} />
    </div>
    <p className="connection-meta"><span>Scope</span><strong>{mcpScopeSummary(server)}</strong></p>
    {server.package ? <p className="connection-meta"><span>Pinned</span><strong>{server.package}</strong></p> : null}
    <p className="muted">{server.reason}</p>

    {server.missingDependencies.length > 0 ? <div className="banner warn">
      <strong>Not installed on this machine.</strong> FLOW will not install it for you.
      {server.setup ? <> Run: <code>{server.setup}</code></> : null}
      {server.docsUrl ? <> <a href={server.docsUrl} target="_blank" rel="noreferrer">Documentation</a></> : null}
    </div> : null}

    {server.unscopedWrites ? <div className="banner danger">
      <strong>FLOW cannot scope this provider's tools.</strong> Its OAuth token belongs to the
      MCP client, so there is no tool list to build an allowlist from. It reaches a session
      with every tool it offers, and its writes are stopped only at publication, by
      <code>fde approve-publish</code>. If you know its read tool names, pin them in the
      settings below and the allowlist becomes enforced.
    </div> : null}

    {server.state === 'blocked' && server.enforceableTools?.length === 0 ? <div className="banner danger">
      <strong>Held back on purpose.</strong> This server exposes tools that can change
      things, and FLOW has no verified read-only subset to hand its client. It stays
      inactive rather than being described as safe.
    </div> : null}

    {error ? <ErrorState error={error} /> : null}

    {fields.length > 0 || secrets.length > 0 ? <>
      <button className="action" onClick={() => setOpen(!open)}>
        {open ? 'Hide setup' : server.state === 'not_configured' ? 'Set it up' : 'Settings'}
      </button>
      {open ? <>
        {fields.length > 0 ? <form className="connection-add" onSubmit={(event) => void save(event)}>
          {fields.map((field) => <label key={field.name}>
            <span>{field.label}{field.required ? '' : ' (optional)'}</span>
            {field.type === 'select'
              ? <select value={values[field.name] ?? ''}
                onChange={(event) => setValues((v) => ({ ...v, [field.name]: event.target.value }))}>
                {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              : <input type={field.type === 'url' ? 'url' : 'text'}
                placeholder={field.placeholder ?? ''} value={values[field.name] ?? ''}
                onChange={(event) => setValues((v) => ({ ...v, [field.name]: event.target.value }))} />}
            {field.help ? <small className="muted">{field.help}</small> : null}
            {field.warning ? <small className="banner danger">{field.warning}</small> : null}
          </label>)}
          <button className="action primary" disabled={busy === 'save'}>
            {busy === 'save' ? 'Saving…' : 'Save settings'}
          </button>
        </form> : null}
        {secrets.map((field) => <SecretRow key={field.name} server={server} field={field} reload={reload} />)}
      </> : null}
    </> : null}

    <div className="connection-actions">
      <button className="action" disabled={busy !== null}
        onClick={() => void act('verify', async () => apiSend(
          `/api/mcp/servers/${encodeURIComponent(server.name)}/verify`, 'POST', {}))}>
        {busy === 'verify' ? 'Checking…' : 'Verify'}
      </button>
      <button className="action" disabled={busy !== null}
        onClick={() => void act('enable', async () => apiSend(
          `/api/mcp/servers/${encodeURIComponent(server.name)}/enable`, 'POST',
          { enabled: !server.enabled }))}>
        {server.enabled ? 'Disable' : 'Enable'}
      </button>
      {server.docsUrl ? <a href={server.docsUrl} target="_blank" rel="noreferrer">Documentation</a> : null}
    </div>

    <details className="mcp-guidance">
      <summary>When this should and should not be used</summary>
      {server.useWhen ? <p><strong>Use it for:</strong> {server.useWhen}</p> : null}
      {server.preferOver.length > 0 ? <p><strong>Prefer it over:</strong> {server.preferOver.join('; ')}</p> : null}
      {server.doNotUseWhen ? <p><strong>Not for:</strong> {server.doNotUseWhen}</p> : null}
      {server.enforceableTools && server.enforceableTools.length > 0
        ? <p><strong>Allowed tools:</strong> {server.enforceableTools.join(', ')}</p>
        : null}
      <p className="muted">{server.note}</p>
    </details>
  </article>
}

export function McpCatalogView(): JSX.Element {
  // Poll, because the catalogue and the user configuration can also be changed
  // by the controller CLI or another open console.
  const catalogue = useApi<McpListResponse>('/api/mcp/servers', 10_000)
  const gateway = useApi<McpGatewayResponse>('/api/mcp/gateway', 60_000)
  const [profile, setProfile] = useState('')
  if (catalogue.error) return <ErrorState error={catalogue.error} />
  if (!catalogue.data) return <Loading label="Reading the MCP catalogue…" />
  const { servers, profiles } = catalogue.data
  const shown = profile === ''
    ? servers
    : servers.filter((server) => server.profiles.length === 0 || server.profiles.includes(profile))
  const reload = (): void => { catalogue.reload(); gateway.reload() }

  return <section className="settings-section">
    <div className="settings-hero">
      <div>
        <p className="eyebrow">Model Context Protocol</p>
        <h2>MCP servers</h2>
        <p className="lede">
          Being listed here is not access. A server is in the <strong>catalogue</strong> when
          FLOW knows how to run it, <strong>configured</strong> when you have supplied what it
          needs, <strong>ready</strong> when it is also installed and verified, and
          <strong> active</strong> only inside a run or chat whose approved roles, stages and
          profile actually call for it.
        </p>
      </div>
      <div className="security-note">
        <strong>Credentials stay local</strong>
        <span>Stored owner-only and injected into one child process. Nothing on this page ever shows a stored value.</span>
      </div>
    </div>

    {!catalogue.data.catalogue.valid ? <div className="banner danger">
      <strong>The catalogue is not usable.</strong> Nothing will be generated until it is fixed:
      <ul>{catalogue.data.catalogue.problems.slice(0, 6).map((problem) => <li key={problem}>{problem}</li>)}</ul>
    </div> : null}

    <label className="mcp-profile-filter"><span>Profile</span>
      <select value={profile} onChange={(event) => setProfile(event.target.value)}>
        <option value="">all servers</option>
        {profiles.map((item) => <option key={item.name} value={item.name}>{item.label}</option>)}
      </select>
      {profile !== ''
        ? <small className="muted">{profiles.find((p) => p.name === profile)?.description}</small>
        : null}
    </label>

    {gateway.data ? <div className="banner">
      <strong>Docker MCP Gateway:</strong> {gateway.data.available ? 'available' : 'not installed'} — {gateway.data.detail}.
      {' '}Docker is optional; nothing in FLOW requires it.
      {gateway.data.available && Object.keys(gateway.data.routedThroughGateway).length > 0
        ? <> These would run through the gateway instead of directly: {Object.keys(gateway.data.routedThroughGateway).sort().join(', ')}.</>
        : null}
    </div> : null}

    {shown.length === 0
      ? <EmptyState title="No MCP servers in this profile">Choose another profile, or add an entry to the catalogue.</EmptyState>
      : <div className="connection-grid">
        {shown.map((server) => <ServerCard key={server.name} server={server} reload={reload} />)}
      </div>}
  </section>
}
