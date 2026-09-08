import { useState } from 'react'
import { Link } from '../../lib/router'
import { formatTime } from '../../lib/format'
import type { ChatSummary } from '../../lib/types'
import { useApi } from '../../lib/useApi'
import { EmptyState, ErrorState, Loading } from '../../components/States'
import { ApiError, apiSend } from '../../lib/api'
import { announceChange } from '../../lib/changes'

export function ChatsView(): JSX.Element {
  const chats = useApi<{ chats: ChatSummary[] }>('/api/chats', 5000)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<ApiError | null>(null)

  const deleteChat = async (chat: ChatSummary): Promise<void> => {
    if (!window.confirm(
      `Delete “${chat.title}” from this console? The chat record will be moved to recoverable trash. Attached files are not deleted.`,
    )) return
    setDeleting(chat.chatId)
    setDeleteError(null)
    try {
      await apiSend(`/api/chats/${encodeURIComponent(chat.chatId)}`, 'DELETE')
      announceChange()
      chats.reload()
    } catch (cause) {
      setDeleteError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not delete this chat.'))
    } finally {
      setDeleting(null)
    }
  }
  return (
    <>
      <div className="stack" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Chats</h1>
      <p className="lede">General Claude, Bedrock, ChatGPT / Codex and Gemini conversations, separate from governed FDE runs.</p>
        </div>
        <Link className="action" to="/chats/new">New chat</Link>
      </div>
      {chats.error ? <ErrorState error={chats.error} onRetry={chats.reload} /> : null}
      {deleteError ? <ErrorState error={deleteError} /> : null}
      {chats.loading && chats.data === null ? <Loading label="Loading chats…" /> : null}
      {chats.data?.chats.length === 0 ? (
        <EmptyState title="No chats yet">Start a general conversation with one of your Claude accounts.</EmptyState>
      ) : null}
      <div className="grid">
        {(chats.data?.chats ?? []).map((chat) => (
          <article className="card" key={chat.chatId}>
            <h2 style={{ margin: '0 0 4px' }}><Link to={`/chats/${chat.chatId}`}>{chat.title}</Link></h2>
            <p className="muted" style={{ margin: '4px 0 10px' }}>{chat.lastMessage ?? 'No messages yet.'}</p>
            <div className="stack">
              <span className={`badge ${chat.status === 'running' ? 'warn' : chat.status === 'failed' ? 'danger' : 'ok'}`}>{chat.status}</span>
              <span className="badge">{chat.profile}</span>
              <span className="badge">{chat.model} · {chat.effort}</span>
              <span className="muted">{chat.messageCount} messages · {formatTime(chat.updatedAt)}</span>
              <button
                className="action danger"
                type="button"
                disabled={chat.status === 'running' || deleting === chat.chatId}
                onClick={() => void deleteChat(chat)}
              >
                {deleting === chat.chatId ? 'Deleting…' : chat.status === 'running' ? 'Stop to delete' : 'Delete chat'}
              </button>
            </div>
          </article>
        ))}
      </div>
    </>
  )
}
