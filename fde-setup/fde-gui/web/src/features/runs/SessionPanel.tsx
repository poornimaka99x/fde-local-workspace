import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, apiGet, apiSend } from '../../lib/api'
import { announceChange } from '../../lib/changes'
import { formatTime } from '../../lib/format'
import type { RunStatus, ConsoleSession, SessionState } from '../../lib/types'
import { ErrorState } from '../../components/States'
import { TerminalView, type TerminalHandle } from '../../components/TerminalView'

interface ResumeResult {
  status: 'started' | 'existing'
  session: ConsoleSession
  ticket: string
}

/**
 * The console side of one orchestrator session.
 *
 * It can start exactly one thing — `fde-start --resume <run-id>` — attach to it,
 * type into it and stop it. Closing the tab detaches; it never stops the
 * process. A Codex-led run gets the controller's own explanation instead of a
 * button that could not work.
 */
export function SessionPanel({
  run,
  autoStart = false,
  forceStopDelayMs = 4000,
}: {
  run: RunStatus
  /** Start and attach once after a newly-created Claude run opens this tab. */
  autoStart?: boolean
  /** How long an interrupt is given before force-stop is offered. */
  forceStopDelayMs?: number
}): JSX.Element {
  const [state, setState] = useState<SessionState | null>(null)
  const [session, setSession] = useState<ConsoleSession | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [offerForce, setOfferForce] = useState(false)
  const [exitCode, setExitCode] = useState<number | null>(null)

  const socket = useRef<WebSocket | null>(null)
  const terminal = useRef<TerminalHandle>(null)
  const autoStartConsumed = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const current = await apiGet<SessionState>(`/api/runs/${encodeURIComponent(run.runId)}/session`)
      setState(current)
      setSession(current.session)
      if (current.session?.status === 'exited') setExitCode(current.session.exitCode)
    } catch (cause) {
      if (cause instanceof ApiError) setError(cause)
    }
  }, [run.runId])

  useEffect(() => {
    void refresh()
    return () => {
      // Detach only. The process keeps running; Stop is a deliberate action.
      socket.current?.close()
      socket.current = null
    }
  }, [refresh])

  const attach = useCallback(
    (ticket: string) => {
      const url = `ws://${window.location.host}/api/runs/${encodeURIComponent(run.runId)}/session/terminal?ticket=${encodeURIComponent(ticket)}`
      const connection = new WebSocket(url)
      socket.current = connection
      connection.onopen = () => setConnected(true)
      connection.onclose = () => setConnected(false)
      connection.onerror = () =>
        setError(new ApiError(0, 'terminal', 'The terminal connection dropped.'))
      connection.onmessage = (event: MessageEvent<string>) => {
        let message: Record<string, unknown>
        try {
          message = JSON.parse(event.data) as Record<string, unknown>
        } catch {
          return
        }
        if (message.type === 'ready') {
          const backlog = typeof message.backlog === 'string' ? message.backlog : ''
          if (backlog !== '') terminal.current?.write(backlog)
          terminal.current?.focus()
          return
        }
        if (message.type === 'output' && typeof message.data === 'string') {
          terminal.current?.write(message.data)
          return
        }
        if (message.type === 'exit') {
          const code = typeof message.exitCode === 'number' ? message.exitCode : null
          setExitCode(code)
          void refresh()
          announceChange()
        }
      }
    },
    [run.runId, refresh],
  )

  const resume = useCallback(async (): Promise<void> => {
    setConnecting(true)
    setError(null)
    setExitCode(null)
    try {
      const result = await apiSend<ResumeResult>(
        `/api/runs/${encodeURIComponent(run.runId)}/session/resume`,
        'POST',
        {},
      )
      setSession(result.session)
      socket.current?.close()
      attach(result.ticket)
      announceChange()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not reach the local server.'))
    } finally {
      setConnecting(false)
    }
  }, [attach, run.runId])

  useEffect(() => {
    if (!autoStart || autoStartConsumed.current || state === null || state.available === false) return
    autoStartConsumed.current = true
    // The query flag is an edge trigger. Removing it prevents a reload from
    // launching a completed session again; the running-session path below can
    // still issue a fresh ticket and attach on demand.
    const location = new URL(window.location.href)
    location.searchParams.delete('startSession')
    window.history.replaceState(window.history.state, '', `${location.pathname}${location.search}${location.hash}`)
    void resume()
  }, [autoStart, resume, state])

  const stop = async (force: boolean): Promise<void> => {
    setStopping(true)
    setError(null)
    try {
      const stopped = await apiSend<ConsoleSession>(
        `/api/runs/${encodeURIComponent(run.runId)}/session/stop`,
        'POST',
        { force },
      )
      setSession(stopped)
      if (!force) window.setTimeout(() => setOfferForce(true), forceStopDelayMs)
      else setOfferForce(false)
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not reach the local server.'))
    } finally {
      setStopping(false)
    }
  }

  const send = (payload: Record<string, unknown>): void => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(payload))
  }

  const running = session?.status === 'running'
  const resumable = run.session.resumable && run.session.provider === 'claude'

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Orchestrator session</h2>
        <table>
          <tbody>
            <tr>
              <th scope="row">Orchestrator</th>
              <td>{run.roles.orchestrator?.label ?? <span className="muted">not chosen</span>}</td>
            </tr>
            <tr>
              <th scope="row">Provider</th>
              <td>{run.session.provider ?? '—'}</td>
            </tr>
            <tr>
              <th scope="row">Profile</th>
              <td>{run.session.profile ?? '—'}</td>
            </tr>
            <tr>
              <th scope="row">Session id</th>
              <td className="mono">
                {run.session.sessionId ?? <span className="muted">none recorded</span>}
              </td>
            </tr>
            <tr>
              <th scope="row">Resumable</th>
              <td>
                <span className={`badge ${resumable ? 'ok' : ''}`}>{resumable ? 'yes' : 'no'}</span>
              </td>
            </tr>
          </tbody>
        </table>
        {run.session.resumeReason ? <p className="muted">{run.session.resumeReason}</p> : null}

        {error ? <ErrorState error={error} /> : null}

        {!resumable ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            This console will not invent a resume path that does not exist.
          </p>
        ) : state?.available === false ? (
          <>
            <p className="banner warn">
              This installation has no terminal backend, so the console will not start a session.
            </p>
            <pre>fde-start --resume {run.runId}</pre>
          </>
        ) : (
          <div className="stack">
            {!running ? (
              <button className="action" type="button" onClick={() => void resume()} disabled={connecting}>
                {connecting ? 'Starting…' : session === null ? 'Resume session' : 'Start again'}
              </button>
            ) : (
              <>
                {!connected ? (
                  <button className="action" type="button" onClick={() => void resume()} disabled={connecting}>
                    {connecting ? 'Attaching…' : 'Attach'}
                  </button>
                ) : null}
                <button className="action" type="button" onClick={() => void stop(false)} disabled={stopping}>
                  Stop
                </button>
                {offerForce ? (
                  <button
                    className="action"
                    type="button"
                    onClick={() => {
                      if (window.confirm('Force stop? The session is killed immediately and anything it was mid-way through is lost.')) {
                        void stop(true)
                      }
                    }}
                  >
                    Force stop
                  </button>
                ) : null}
                <span className={`badge ${connected ? 'ok' : 'warn'}`}>
                  {connected ? 'attached' : 'detached'}
                </span>
              </>
            )}
            {session !== null ? (
              <span className="muted">
                pid {session.pid} · started {formatTime(session.startedAt)} · {session.attachedClients} viewer(s)
              </span>
            ) : null}
          </div>
        )}

        {session?.stopRequestedAt ? (
          <p className="muted">Interrupt sent {formatTime(session.stopRequestedAt)}.</p>
        ) : null}
        {exitCode !== null ? (
          <p className={`badge ${exitCode === 0 ? 'ok' : 'warn'}`} role="status">
            Session exited with code {exitCode}
          </p>
        ) : null}
      </div>

      {session !== null ? (
        <>
          <TerminalView
            ref={terminal}
            readOnly={!running}
            onInput={(data) => send({ type: 'input', data })}
            onResize={(cols, rows) => send({ type: 'resize', cols, rows })}
          />
          <p className="muted">
            This terminal is the <code>fde-start --resume</code> process for this run — not a shell.
            Closing the tab detaches; it does not stop the session. The transcript is kept in memory
            only, for as long as this server runs.
          </p>
        </>
      ) : null}
    </>
  )
}
