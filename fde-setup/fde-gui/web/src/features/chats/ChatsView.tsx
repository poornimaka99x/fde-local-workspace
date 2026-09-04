import { Link } from '../../lib/router'
import { formatTime } from '../../lib/format'
import type { ChatSummary } from '../../lib/types'
import { useApi } from '../../lib/useApi'
import { EmptyState, ErrorState, Loading } from '../../components/States'

export function ChatsView(): JSX.Element {
  const chats = useApi<{ chats: ChatSummary[] }>('/api/chats', 5000)
  return (
    <>
      <div className="stack" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Chats</h1>
          <p className="lede">General Claude conversations, separate from governed FDE runs.</p>
        </div>
        <Link className="action" to="/chats/new">New chat</Link>
      </div>
      {chats.error ? <ErrorState error={chats.error} onRetry={chats.reload} /> : null}
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
            </div>
          </article>
        ))}
      </div>
    </>
  )
}
