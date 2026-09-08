import { useState, type FormEvent } from 'react'
import { Markdown } from '../../components/Markdown'
import { PathBrowser } from '../../components/PathBrowser'
import { ErrorState, Loading } from '../../components/States'
import { ApiError, apiSend } from '../../lib/api'
import { announceChange } from '../../lib/changes'
import { formatTime } from '../../lib/format'
import { Link } from '../../lib/router'
import type { ChatRecord } from '../../lib/types'
import { useApi } from '../../lib/useApi'

export function ChatDetail({ chatId }: { chatId: string }): JSX.Element {
  const state = useApi<{ chat: ChatRecord }>(`/api/chats/${encodeURIComponent(chatId)}`, 3000)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [attaching, setAttaching] = useState(false)
  const [attachError, setAttachError] = useState<ApiError | null>(null)
  const [deleting, setDeleting] = useState(false)

  const send = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const prompt = message.trim()
    if (!prompt) return
    setSending(true)
    setError(null)
    setMessage('')
    try {
      const result = await apiSend<{ chat: ChatRecord }>(
        `/api/chats/${encodeURIComponent(chatId)}/messages`,
        'POST',
        { message: prompt },
      )
      if (result.chat.status === 'failed') {
        setMessage(prompt)
        setError(new ApiError(
          502,
          'claude-failed',
          result.chat.lastError ?? 'The selected provider did not complete this message.',
        ))
      }
      state.reload()
    } catch (cause) {
      setMessage(prompt)
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not send this message.'))
    } finally {
      setSending(false)
    }
  }

  const stop = async (): Promise<void> => {
    try {
      await apiSend(`/api/chats/${encodeURIComponent(chatId)}/stop`, 'POST', {})
      state.reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not stop the response.'))
    }
  }

  const attach = async (attachPath: string): Promise<void> => {
    setAttachError(null)
    try {
      await apiSend<{ chat: ChatRecord }>(`/api/chats/${encodeURIComponent(chatId)}/attachments`, 'POST', { path: attachPath })
      setAttaching(false)
      state.reload()
    } catch (cause) {
      setAttachError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not attach that path.'))
    }
  }

  const detach = async (attachmentId: string): Promise<void> => {
    setAttachError(null)
    try {
      await apiSend<{ chat: ChatRecord }>(
        `/api/chats/${encodeURIComponent(chatId)}/attachments/${encodeURIComponent(attachmentId)}`,
        'DELETE',
      )
      state.reload()
    } catch (cause) {
      setAttachError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not remove that attachment.'))
    }
  }

  if (state.loading && state.data === null) return <Loading label="Loading chat…" />
  if (state.error && state.data === null) return <ErrorState error={state.error} onRetry={state.reload} />
  const chat = state.data?.chat
  if (!chat) return <Loading label="Loading chat…" />
  const assistantName = chat.provider === 'codex'
    ? 'ChatGPT / Codex'
    : chat.provider === 'gemini' ? 'Gemini'
      : chat.provider === 'bedrock' ? 'Claude on Bedrock' : 'Claude'

  const deleteChat = async (): Promise<void> => {
    if (!window.confirm(
      `Delete “${chat.title}” from this console? The chat record will be moved to recoverable trash. Attached files are not deleted.`,
    )) return
    setDeleting(true)
    setError(null)
    try {
      await apiSend(`/api/chats/${encodeURIComponent(chatId)}`, 'DELETE')
      announceChange()
      window.history.pushState(null, '', '/chats')
      window.dispatchEvent(new PopStateEvent('popstate'))
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not delete this chat.'))
      setDeleting(false)
    }
  }

  return (
    <>
      <div className="stack" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>{chat.title}</h1>
          <p className="lede">{chat.profile} · {chat.model} · {chat.effort}{chat.projectId ? ` · ${chat.projectId}` : ''}</p>
        </div>
        <div className="stack">
          <Link className="action" to="/chats">All chats</Link>
          <Link className="action" to="/chats/new">New chat</Link>
          <button
            className="action danger"
            type="button"
            disabled={chat.status === 'running' || sending || deleting}
            onClick={() => void deleteChat()}
          >
            {deleting ? 'Deleting…' : chat.status === 'running' || sending ? 'Stop to delete' : 'Delete chat'}
          </button>
        </div>
      </div>
      {error ? <ErrorState error={error} /> : null}
      {chat.lastError ? <div className="banner danger" role="alert">{chat.lastError}</div> : null}

      <div className="card">
        <div className="stack" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Attachments</h3>
          <button className="action" type="button" onClick={() => setAttaching(true)}>Attach file or folder…</button>
        </div>
        {attachError ? <ErrorState error={attachError} /> : null}
        {chat.attachments.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            None yet. An attached file is re-read and folded into the message as context every time you
            send; an attached folder is listed by name only, not its contents.
          </p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
            {chat.attachments.map((item) => (
              <li key={item.id} className="stack" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                <span className="mono">{item.path}{item.kind === 'directory' ? '/' : ''}</span>
                <button className="action" type="button" onClick={() => void detach(item.id)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {attaching ? (
        <PathBrowser
          title="Attach a file or folder"
          mode="any"
          onSelect={(picked) => void attach(picked)}
          onClose={() => setAttaching(false)}
        />
      ) : null}
      <div className="chat-thread" aria-live="polite">
        {chat.messages.length === 0 ? <p className="muted">Send the first message.</p> : null}
        {chat.messages.map((item) => (
          <article className={`chat-message ${item.role}`} key={item.id}>
            <header><strong>{item.role === 'user' ? 'You' : assistantName}</strong><span className="muted">{formatTime(item.createdAt)}</span></header>
            {item.role === 'assistant' ? <Markdown source={item.content} /> : <p>{item.content}</p>}
          </article>
        ))}
        {(sending || chat.status === 'running') ? <div className="chat-message assistant muted" role="status">{assistantName} is responding…</div> : null}
      </div>
      <form className="card chat-composer" onSubmit={(event) => void send(event)}>
        <label htmlFor="chat-message"><strong>Message</strong></label>
        <textarea id="chat-message" rows={4} maxLength={20000} value={message} onChange={(event) => setMessage(event.target.value)} disabled={sending} />
        <div className="stack">
          <button className="action primary" type="submit" disabled={sending || message.trim() === ''}>{sending ? 'Sending…' : 'Send'}</button>
          {(sending || chat.status === 'running') ? <button className="action" type="button" onClick={() => void stop()}>Stop</button> : null}
        </div>
      </form>
    </>
  )
}
