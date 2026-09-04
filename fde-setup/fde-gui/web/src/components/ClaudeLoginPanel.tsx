import { useEffect, useRef, useState } from 'react'
import { ApiError, apiSend } from '../lib/api'
import type { ClaudeAccount, ConsoleSession } from '../lib/types'
import { ErrorState } from './States'
import { TerminalView, type TerminalHandle } from './TerminalView'

interface LoginResult {
  status: 'started' | 'existing'
  session: ConsoleSession
  ticket: string
}

export default function ClaudeLoginPanel({
  account,
  onFinished,
}: {
  account: ClaudeAccount
  onFinished: () => void
}): JSX.Element {
  const [session, setSession] = useState<ConsoleSession | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const socket = useRef<WebSocket | null>(null)
  const terminal = useRef<TerminalHandle>(null)

  useEffect(() => () => socket.current?.close(), [])

  const start = async (): Promise<void> => {
    setError(null)
    try {
      const result = await apiSend<LoginResult>(
        `/api/claude/accounts/${encodeURIComponent(account.id)}/login`,
        'POST',
        {},
      )
      setSession(result.session)
      const connection = new WebSocket(
        `ws://${window.location.host}/api/claude/accounts/${encodeURIComponent(account.id)}/login/terminal?ticket=${encodeURIComponent(result.ticket)}`,
      )
      socket.current = connection
      connection.onmessage = (event: MessageEvent<string>) => {
        let message: Record<string, unknown>
        try {
          message = JSON.parse(event.data) as Record<string, unknown>
        } catch {
          return
        }
        if (message.type === 'ready' && typeof message.backlog === 'string') terminal.current?.write(message.backlog)
        if (message.type === 'output' && typeof message.data === 'string') terminal.current?.write(message.data)
        if (message.type === 'exit') {
          setSession((current) => current === null ? null : { ...current, status: 'exited' })
          onFinished()
        }
      }
      connection.onerror = () => setError(new ApiError(0, 'terminal', 'The login terminal connection dropped.'))
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not start Claude login.'))
    }
  }

  const send = (payload: Record<string, unknown>): void => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(payload))
  }

  return (
    <div className="login-panel">
      {error ? <ErrorState error={error} /> : null}
      {session === null ? (
        <button className="action" type="button" onClick={() => void start()}>Login to {account.label}</button>
      ) : (
        <>
          <p className="muted">Complete the Claude sign-in flow below. Credentials are handled by Claude Code, not this GUI.</p>
          <TerminalView
            ref={terminal}
            ariaLabel="Claude account login terminal"
            readOnly={session.status !== 'running'}
            onInput={(data) => send({ type: 'input', data })}
            onResize={(cols, rows) => send({ type: 'resize', cols, rows })}
          />
        </>
      )}
    </div>
  )
}
