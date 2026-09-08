import { useState, type FormEvent } from 'react'
import { ClaudeSettings } from '../../components/ClaudeSettings'
import { ErrorState } from '../../components/States'
import { ApiError, apiSend } from '../../lib/api'
import type { ChatRecord, ClaudeEffort, ProjectListResponse } from '../../lib/types'
import { useApi } from '../../lib/useApi'

export function NewChatForm(): JSX.Element {
  const projects = useApi<ProjectListResponse>('/api/projects')
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState('')
  const [accountId, setAccountId] = useState('work')
  const [model, setModel] = useState('default')
  const [effort, setEffort] = useState<ClaudeEffort>('auto')
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
        <p className="banner warn">
          Claude chats have tools disabled. Codex chats run read-only without approvals. Gemini chats run Antigravity in plan mode and a restricted sandbox. Select a project only to set the conversation’s working directory.
        </p>
        <div className="stack">
          <button className="action primary" type="submit" disabled={saving || accountId === ''}>{saving ? 'Creating…' : 'Create chat'}</button>
          <a className="action" href="/chats">Cancel</a>
        </div>
      </form>
    </>
  )
}
