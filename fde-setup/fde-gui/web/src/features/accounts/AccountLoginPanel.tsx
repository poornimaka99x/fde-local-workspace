import { useEffect, useRef, useState } from 'react'
import { ApiError, apiSend } from '../../lib/api'
import type { ConsoleSession, ProviderAccount } from '../../lib/types'
import { ErrorState } from '../../components/States'
import { TerminalView, type TerminalHandle } from '../../components/TerminalView'

interface LoginResult {
  status: 'started' | 'existing'
  session: ConsoleSession
  ticket: string
  instruction?: string | null
}

/**
 * The interactive sign-in for one account.
 *
 * The console runs no login command of its own: it asks the controller to start
 * one, and the controller answers with the exact argv and the credential
 * environment for that account. What appears below is that process's own
 * terminal — the operator reads the provider's prompts and types into them, and
 * the credential is written by the provider's CLI into the account's own
 * directory. Nothing typed here passes through this component's state.
 */
export function AccountLoginPanel({
  account,
  onFinished,
}: {
  account: ProviderAccount
  onFinished: () => void
}): JSX.Element {
  const [session, setSession] = useState<ConsoleSession | null>(null)
  const [instruction, setInstruction] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const socket = useRef<WebSocket | null>(null)
  const terminal = useRef<TerminalHandle>(null)

  useEffect(() => () => socket.current?.close(), [])

  const start = async (): Promise<void> => {
    setError(null)
    const base = `/api/accounts/${encodeURIComponent(account.id)}/login`
    try {
      const result = await apiSend<LoginResult>(base, 'POST', {})
      setSession(result.session)
      setInstruction(result.instruction ?? account.loginDetail)
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const connection = new WebSocket(
        `${protocol}://${window.location.host}${base}/terminal?ticket=${encodeURIComponent(result.ticket)}`,
      )
      socket.current = connection
      connection.onmessage = (event: MessageEvent<string>) => {
        let message: Record<string, unknown>
        try {
          message = JSON.parse(event.data) as Record<string, unknown>
        } catch {
          return
        }
        if (message.type === 'ready' && typeof message.backlog === 'string') {
          terminal.current?.write(message.backlog)
        }
        if (message.type === 'output' && typeof message.data === 'string') {
          terminal.current?.write(message.data)
        }
        if (message.type === 'exit') {
          setSession((current) => (current === null ? null : { ...current, status: 'exited' }))
          // The sign-in is only believed once the controller has re-checked it.
          onFinished()
        }
      }
      connection.onerror = () =>
        setError(new ApiError(0, 'terminal', 'The sign-in terminal connection dropped.'))
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause
          : new ApiError(0, 'network', 'Could not start the sign-in.'),
      )
    }
  }

  const stop = async (): Promise<void> => {
    try {
      await apiSend(`/api/accounts/${encodeURIComponent(account.id)}/login/stop`, 'POST', {})
    } catch {
      /* Already gone is the outcome we wanted. */
    }
    socket.current?.close()
    setSession(null)
    onFinished()
  }

  const send = (payload: Record<string, unknown>): void => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(payload))
  }

  return (
    <div className="login-panel">
      {error ? <ErrorState error={error} /> : null}
      {session === null ? (
        <button className="action" type="button" onClick={() => void start()}>
          Sign in to {account.label}
        </button>
      ) : (
        <>
          <p className="muted">
            {instruction ?? 'Complete the provider sign-in below.'} The credential is written by
            that CLI into this account&rsquo;s own folder; this console never sees it.
          </p>
          <TerminalView
            ref={terminal}
            ariaLabel={`Sign-in terminal for ${account.label}`}
            readOnly={session.status !== 'running'}
            onInput={(data) => send({ type: 'input', data })}
            onResize={(cols, rows) => send({ type: 'resize', cols, rows })}
          />
          <p className="row">
            <button className="action" type="button" onClick={() => void stop()}>
              Done
            </button>
            <span className="muted">
              Closing this checks the sign-in with the provider rather than assuming it worked.
            </span>
          </p>
        </>
      )}
    </div>
  )
}
