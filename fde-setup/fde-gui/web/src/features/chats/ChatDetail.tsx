import { useState, type FormEvent } from 'react'
import { Markdown } from '../../components/Markdown'
import { ErrorState, Loading } from '../../components/States'
import { ApiError, apiSend } from '../../lib/api'
import { formatTime } from '../../lib/format'
import { Link } from '../../lib/router'
import type { ChatRecord } from '../../lib/types'
import { useApi } from '../../lib/useApi'

export function ChatDetail({ chatId }: { chatId: string }): JSX.Element {
  const state = useApi<{ chat: ChatRecord }>(`/api/chats/${encodeURIComponent(chatId)}`, 3000)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  const send = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const prompt = message.trim()
    if (!prompt) return
    setSending(true)
    setError(null)
    setMessage('')
    try {
      await apiSend<{ chat: ChatRecord }>(`/api/chats/${encodeURIComponent(chatId)}/messages`, 'POST', { message: prompt })
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
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not stop Claude.'))
    }
  }

  if (state.loading && state.data === null) return <Loading label="Loading chat…" />
  if (state.error && state.data === null) return <ErrorState error={state.error} onRetry={state.reload} />
  const chat = state.data?.chat
  if (!chat) return <Loading label="Loading chat…" />

  return (
    <>
      <div className="stack" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>{chat.title}</h1>
          <p className="lede">{chat.profile} · {chat.model} · {chat.effort}{chat.projectId ? ` · ${chat.projectId}` : ''}</p>
        </div>
        <div className="stack"><Link className="action" to="/chats">All chats</Link><Link className="action" to="/chats/new">New chat</Link></div>
      </div>
      {error ? <ErrorState error={error} /> : null}
      {chat.lastError ? <div className="banner danger" role="alert">{chat.lastError}</div> : null}
      <div className="chat-thread" aria-live="polite">
        {chat.messages.length === 0 ? <p className="muted">Send the first message.</p> : null}
        {chat.messages.map((item) => (
          <article className={`chat-message ${item.role}`} key={item.id}>
            <header><strong>{item.role === 'user' ? 'You' : 'Claude'}</strong><span className="muted">{formatTime(item.createdAt)}</span></header>
            {item.role === 'assistant' ? <Markdown source={item.content} /> : <p>{item.content}</p>}
          </article>
        ))}
        {(sending || chat.status === 'running') ? <div className="chat-message assistant muted" role="status">Claude is responding…</div> : null}
      </div>
      <form className="card chat-composer" onSubmit={(event) => void send(event)}>
        <label htmlFor="chat-message"><strong>Message</strong></label>
        <textarea id="chat-message" rows={4} maxLength={20000} value={message} onChange={(event) => setMessage(event.target.value)} disabled={sending} />
        <div className="stack">
          <button className="action" type="submit" disabled={sending || message.trim() === ''}>{sending ? 'Sending…' : 'Send'}</button>
          {(sending || chat.status === 'running') ? <button className="action" type="button" onClick={() => void stop()}>Stop</button> : null}
        </div>
      </form>
    </>
  )
}
