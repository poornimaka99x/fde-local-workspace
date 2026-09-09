import { useState, type FormEvent } from 'react'
import { ApiError, apiSend } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import type {
  ConnectionDetailResponse, ConnectionListResponse, ConnectionProvider,
  ConnectionProviderListResponse, ServiceConnection,
} from '../../lib/types'
import { EmptyState, ErrorState, Loading } from '../../components/States'

function statusClass(status: string): string {
  if (status === 'connected') return 'ok'
  if (status === 'forbidden' || status === 'unauthorized' || status === 'verification_failed') return 'danger'
  return 'warn'
}

function ConnectionCard({ connection, provider, reload }: {
  connection: ServiceConnection; provider?: ConnectionProvider; reload: () => void
}): JSX.Element {
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [removing, setRemoving] = useState(false)
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setError(null)
    try { await fn(); reload() } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'The operation failed.'))
    } finally { setBusy(false) }
  }
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const value = secret
    await act(async () => apiSend<ConnectionDetailResponse>(
      `/api/connections/${encodeURIComponent(connection.id)}/secret`, 'POST', { secret: value }))
    setSecret('')
  }
  return <article className="connection-card">
    <div className="connection-card-head">
      <div><p className="eyebrow">{connection.providerLabel}</p><h3>{connection.name}</h3></div>
      <span className={`badge ${statusClass(connection.status)}`}>{connection.status.replaceAll('_', ' ')}</span>
    </div>
    {Object.entries(connection.fields).map(([key, value]) =>
      <p className="connection-meta" key={key}><span>{key}</span><strong>{value}</strong></p>)}
    {connection.verifiedIdentity ? <p className="connection-meta"><span>Signed in as</span><strong>{connection.verifiedIdentity}</strong></p> : null}
    {connection.detail ? <p className="muted">{connection.detail}</p> : null}
    {error ? <ErrorState error={error} /> : null}
    {connection.oauth ? <div className="banner">
      {connection.provider === 'atlassian-rovo' ? <>
        Rovo uses its own Atlassian OAuth sign-in at <code>https://mcp.atlassian.com/v2/mcp</code>. It is separate from the Atlassian REST API token.
      </> : <>
        Figma uses OAuth in the assigned MCP client at <code>https://mcp.figma.com/mcp</code>.
      </>} FDE never receives that OAuth token.
    </div> : <form className="secret-row" onSubmit={(event) => void save(event)}>
      <label><span>{connection.configured ? `Replace ${provider?.secretLabel ?? 'token'}` : provider?.secretLabel ?? 'Token'}</span>
        <input type="password" autoComplete="off" spellCheck={false} value={secret}
          onChange={(event) => setSecret(event.target.value)} /></label>
      <button className="action" disabled={busy || secret.length < 8}>{connection.configured ? 'Replace' : 'Store securely'}</button>
    </form>}
    <div className="connection-actions">
      {!connection.oauth ? <button className="action" disabled={busy} onClick={() => void act(async () => apiSend(
        `/api/connections/${encodeURIComponent(connection.id)}/verify`, 'POST', {}))}>
        {busy ? 'Checking…' : 'Test connection'}
      </button> : null}
      {removing ? <><button className="action danger" disabled={busy} onClick={() => void act(async () => apiSend(
        `/api/connections/${encodeURIComponent(connection.id)}`, 'DELETE'))}>Confirm removal</button>
        <button className="action" onClick={() => setRemoving(false)}>Cancel</button></> :
        <button className="action" onClick={() => setRemoving(true)}>Remove…</button>}
      {provider ? <a href={provider.docsUrl} target="_blank" rel="noreferrer">Provider documentation</a> : null}
    </div>
  </article>
}

export function ConnectionsView(): JSX.Element {
  const providers = useApi<ConnectionProviderListResponse>('/api/connections/providers')
  // Connections may be added by the controller CLI or another open console.
  // Refresh periodically so this inventory remains an honest view of the
  // metadata already stored in the shared FDE configuration.
  const connections = useApi<ConnectionListResponse>('/api/connections', 10_000)
  const [providerId, setProviderId] = useState<ConnectionProvider['provider']>('atlassian')
  const [name, setName] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  if (providers.error) return <ErrorState error={providers.error} />
  if (connections.error) return <ErrorState error={connections.error} />
  if (!providers.data || !connections.data) return <Loading label="Reading service connections…" />
  const selected = providers.data.providers.find((p) => p.provider === providerId) ?? providers.data.providers[0]
  const reload = (): void => { providers.reload(); connections.reload() }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      await apiSend('/api/connections', 'POST', { provider: providerId, name: name.trim(), fields })
      setName(''); setFields({}); reload()
    } catch (cause) { setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not add connection.')) }
    finally { setBusy(false) }
  }
  const byProvider = new Map(providers.data.providers.map((p) => [p.provider, p]))
  return <section className="settings-section">
    <div className="settings-hero"><div><p className="eyebrow">External systems</p><h2>Service connections</h2>
      <p className="lede">Credentials are stored locally and establish identity only. External writes still require an FDE publication approval.</p></div>
      <div className="security-note"><strong>Secrets stay private</strong><span>Tokens are never returned to this page after submission.</span></div>
    </div>
    <form className="connection-add" onSubmit={(event) => void submit(event)}>
      <div className="connection-add-title"><h3>Add a connection</h3><p className="muted">{selected?.note}</p></div>
      {error ? <ErrorState error={error} /> : null}
      <label><span>Provider</span><select value={providerId} onChange={(e) => { setProviderId(e.target.value as ConnectionProvider['provider']); setFields({}) }}>
        {providers.data.providers.map((p) => <option value={p.provider} key={p.provider}>{p.label}</option>)}</select></label>
      <label><span>Connection name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Work, client, sandbox…" /></label>
      {(selected?.fields ?? []).map((field) => <label key={field.name}><span>{field.label}</span>
        <input required={field.required} placeholder={field.placeholder} value={fields[field.name] ?? ''}
          onChange={(e) => setFields((v) => ({ ...v, [field.name]: e.target.value }))} /></label>)}
      <button className="action primary" disabled={busy || !name.trim()}>{busy ? 'Adding…' : 'Add connection'}</button>
    </form>
    {connections.data.connections.length === 0 ? <EmptyState title="No service connections">Add one above. Tokens are entered only after the safe metadata record exists.</EmptyState> :
      <div className="connection-grid">{connections.data.connections.map((c) => <ConnectionCard key={c.id} connection={c} provider={byProvider.get(c.provider)} reload={reload} />)}</div>}
  </section>
}
