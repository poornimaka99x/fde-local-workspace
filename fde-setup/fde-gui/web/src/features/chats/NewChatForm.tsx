import { useState, type FormEvent } from 'react'
import { ClaudeSettings } from '../../components/ClaudeSettings'
import { ErrorState } from '../../components/States'
import { ApiError, apiSend } from '../../lib/api'
import type { ChatRecord, ClaudeEffort, ConnectionListResponse, ProjectListResponse } from '../../lib/types'
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
      <p className="lede">A private conversation using Claude, Bedrock, ChatGPT / Codex or Gemini through Antigravity. It creates no FDE run, roles, approvals or checkpoints.</p>
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
          <legend><strong>Service access</strong> <span className="muted">optional, read-only</span></legend>
          <p className="muted">Allow this chat to read linked content through specific configured connections. Credentials stay in FDE and are never sent to the AI provider.</p>
          {connections.error ? <ErrorState error={connections.error} /> : null}
          {(connections.data?.connections ?? []).filter((connection) => connection.configured).length === 0 ?
            <p className="banner">No configured service connections are available. Add Atlassian REST, Rovo, GitHub, Bitbucket or Figma under Configuration.</p> :
            <div className="service-choice-grid">
              {(connections.data?.connections ?? []).filter((connection) => connection.configured).map((connection) => {
                const checked = serviceConnectionIds.includes(connection.id)
                return <label className={`service-choice${checked ? ' selected' : ''}`} key={connection.id}>
                  <input type="checkbox" checked={checked} onChange={(event) => setServiceConnectionIds((current) =>
                    event.target.checked ? [...current, connection.id] : current.filter((id) => id !== connection.id))} />
                  <span><strong>{connection.name}</strong><small>{connection.providerLabel} · {connection.status.replaceAll('_', ' ')}</small></span>
                </label>
              })}
            </div>}
        </fieldset>
        <p className="banner warn">
          Claude chats have tools disabled. Codex chats run read-only without approvals. Gemini chats run Antigravity in plan mode and a restricted sandbox. Selected REST services resolve only links you include in a message; Rovo and Figma OAuth remain separate MCP connections.
        </p>
        <div className="stack">
          <button className="action primary" type="submit" disabled={saving || accountId === ''}>{saving ? 'Creating…' : 'Create chat'}</button>
          <a className="action" href="/chats">Cancel</a>
        </div>
      </form>
    </>
  )
}
