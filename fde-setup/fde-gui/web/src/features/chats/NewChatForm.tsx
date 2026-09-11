import { useState, type FormEvent } from 'react'
import { ClaudeSettings } from '../../components/ClaudeSettings'
import { ErrorState } from '../../components/States'
import { ApiError, apiSend } from '../../lib/api'
import type { ChatRecord, ClaudeEffort, ConnectionListResponse, ProjectListResponse, ServiceConnection } from '../../lib/types'
import { useApi } from '../../lib/useApi'

export function NewChatForm(): JSX.Element {
  const projects = useApi<ProjectListResponse>('/api/projects')
  const connections = useApi<ConnectionListResponse>('/api/connections')
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState('')
  const [accountId, setAccountId] = useState('work')
  const [model, setModel] = useState('default')
  const [effort, setEffort] = useState<ClaudeEffort>('auto')
  const [serviceConnectionIds, setServiceConnectionIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  // "Read-only" is a claim FLOW has to be able to back. A connection whose tools
  // have never been listed is withheld and named, rather than shown with a label
  // nothing enforces.
  const configured = (connections.data?.connections ?? []).filter((connection) => connection.configured)
  const unverified = configured.filter((connection) =>
    connection.provider === 'custom-mcp' && connection.readOnly === null)
  const selectable = configured.filter((connection) => !unverified.includes(connection))
  const scopeLabel = (connection: ServiceConnection): string => {
    if (connection.provider !== 'custom-mcp' && connection.readOnly == null) return 'read access'
    if (connection.readOnly === true) return 'read-only'
    return 'has tools that can change things'
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const result = await apiSend<{ chat: ChatRecord }>('/api/chats', 'POST', {
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(projectId ? { projectId } : {}),
        accountId,
        model,
        effort,
        serviceConnectionIds,
      })
      window.history.pushState(null, '', `/chats/${result.chat.chatId}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not create the chat.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h1>New chat</h1>
      <p className="lede">A private conversation using Claude, Bedrock, ChatGPT / Codex or Gemini through Antigravity. It creates no FLOW run, roles, approvals or checkpoints.</p>
      {error ? <ErrorState error={error} /> : null}
      <form className="card" onSubmit={(event) => void submit(event)}>
        <div className="form-grid">
          <label>
            <strong>Title</strong> <span className="muted">optional</span>
            <input type="text" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            <strong>Project context</strong> <span className="muted">optional</span>
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">none — general conversation</option>
              {(projects.data?.projects ?? []).map((project) => (
                <option key={project.projectId} value={project.projectId}>{project.name ?? project.projectId}</option>
              ))}
            </select>
          </label>
        </div>
        <ClaudeSettings
          accountId={accountId}
          model={model}
          effort={effort}
          onAccount={setAccountId}
          onModel={setModel}
          onEffort={setEffort}
        />
        <fieldset className="chat-service-access">
          <legend><strong>Service access</strong> <span className="muted">optional, none by default</span></legend>
          <p className="muted">Allow this chat to read linked content through specific configured connections. Credentials stay in FLOW and are never sent to the AI provider.</p>
          {connections.error ? <ErrorState error={connections.error} /> : null}
          {selectable.length === 0 ?
            <p className="banner">No configured service connections are available. Add a built-in service or custom MCP server under Configuration.</p> :
            <div className="service-choice-grid">
              {selectable.map((connection) => {
                const checked = serviceConnectionIds.includes(connection.id)
                return <label className={`service-choice${checked ? ' selected' : ''}`} key={connection.id}>
                  <input type="checkbox" checked={checked} onChange={(event) => setServiceConnectionIds((current) =>
                    event.target.checked ? [...current, connection.id] : current.filter((id) => id !== connection.id))} />
                  <span><strong>{connection.name}</strong>
                    <small>{connection.providerLabel} · {connection.status.replaceAll('_', ' ')} · {scopeLabel(connection)}</small></span>
                </label>
              })}
            </div>}
          {unverified.length > 0 ? <p className="banner warn">
            Not offered yet: {unverified.map((connection) => connection.name).join(', ')}. FLOW has not asked
            {unverified.length === 1 ? ' it' : ' them'} which tools only read, so
            {unverified.length === 1 ? ' it cannot' : ' they cannot'} be described as read-only here. Test the connection
            under Configuration first.
          </p> : null}
        </fieldset>
        <p className="banner warn">
          A chat has no plan, roles or approvals behind it, so a connection is offered only where the tool scope can
          actually be enforced. Codex chats receive an explicit allowlist of the tools that only read. Claude chats
          receive a connection only when every tool it offers reads. Gemini chats run Antigravity in plan mode and a
          restricted sandbox, and its current CLI cannot load per-chat MCP configuration at all. Stored credentials
          enter only the local client process environment; REST services resolve only links included in your message.
        </p>
        <div className="stack">
          <button className="action primary" type="submit" disabled={saving || accountId === ''}>{saving ? 'Creating…' : 'Create chat'}</button>
          <a className="action" href="/chats">Cancel</a>
        </div>
      </form>
    </>
  )
}
