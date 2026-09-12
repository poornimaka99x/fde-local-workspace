import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, apiGet, apiSend } from '../../lib/api'
import { announceChange } from '../../lib/changes'
import { formatTime } from '../../lib/format'
import { useApi } from '../../lib/useApi'
import type {
  ClaudeAccount,
  ClaudeAccountsResponse,
  RunStatus,
  ConsoleSession,
  SessionState,
} from '../../lib/types'
import { ErrorState } from '../../components/States'
import { TerminalView, type TerminalHandle } from '../../components/TerminalView'

interface ResumeResult {
  status: 'started' | 'existing'
  session: ConsoleSession
  ticket: string
}

interface SwitchResult {
  switched: true
  reapprovalRequired: boolean
  run: RunStatus
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
  onRunChanged = () => undefined,
}: {
  run: RunStatus
  /** Start and attach once after a newly-created Claude run opens this tab. */
  autoStart?: boolean
  /** How long an interrupt is given before force-stop is offered. */
  forceStopDelayMs?: number
  /** Refresh the durable run after its orchestrator assignment changes. */
  onRunChanged?: () => void
}): JSX.Element {
  const [state, setState] = useState<SessionState | null>(null)
  const [session, setSession] = useState<ConsoleSession | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [offerForce, setOfferForce] = useState(false)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [showSwitch, setShowSwitch] = useState(false)
  const [switchAccount, setSwitchAccount] = useState('')
  const [switching, setSwitching] = useState(false)
  const [switchNotice, setSwitchNotice] = useState<string | null>(null)
  const accounts = useApi<ClaudeAccountsResponse>('/api/claude/accounts')

  const socket = useRef<WebSocket | null>(null)
  const terminal = useRef<TerminalHandle>(null)
  const automaticConnectionConsumed = useRef(false)

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
    if (automaticConnectionConsumed.current || state === null || state.available === false) return

    // A newly-created run starts once. An already-running run only asks the
    // server for a fresh, single-use viewer ticket; the server returns the
    // existing PTY rather than spawning another process. This makes moving
    // between runs restore their live consoles without an extra Attach click.
    const shouldConnect = autoStart || state.session?.status === 'running'
    if (!shouldConnect) return
    automaticConnectionConsumed.current = true

    if (autoStart) {
      // The query flag is an edge trigger. Removing it prevents a reload from
      // launching a completed session again.
      const location = new URL(window.location.href)
      location.searchParams.delete('startSession')
      window.history.replaceState(window.history.state, '', `${location.pathname}${location.search}${location.hash}`)
    }
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
  const switchCandidates = (accounts.data?.accounts ?? []).filter((account) =>
    account.orchestratorEligible !== false
      && account.provider !== 'codex'
      && account.provider !== 'gemini'
      && account.authState !== 'login_required'
      && account.authState !== 'unavailable'
      && account.identityId !== run.roles.orchestrator?.agentId
      && account.id !== run.session.profile,
  )

  const switchOrchestrator = async (): Promise<void> => {
    const account = switchCandidates.find((candidate) => candidate.id === switchAccount)
    if (account === undefined) return
    if (!window.confirm(
      `Switch this run from ${run.roles.orchestrator?.label ?? 'its current orchestrator'} to ${account.label}? `
      + 'The old chat transcript will not transfer. Durable run files and history remain available.',
    )) return
    setSwitching(true)
    setError(null)
    setSwitchNotice(null)
    try {
      const result = await apiSend<SwitchResult>(
        `/api/runs/${encodeURIComponent(run.runId)}/orchestrator`,
        'POST',
        { accountId: account.id },
      )
      setShowSwitch(false)
      setSwitchAccount('')
      setSwitchNotice(
        result.reapprovalRequired
          ? `Switched to ${account.label}. Start the replacement session, review its revised plan and routing, and approve it when prompted.`
          : `Switched to ${account.label}. Start the replacement session below.`,
      )
      setSession(null)
      setExitCode(null)
      await refresh()
      onRunChanged()
      announceChange()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not reach the local server.'))
    } finally {
      setSwitching(false)
    }
  }

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
        {switchNotice ? <p className="banner ok" role="status">{switchNotice}</p> : null}

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
            <button
              className="action"
              type="button"
              disabled={running || switching}
              onClick={() => setShowSwitch((shown) => !shown)}
            >
              Switch orchestrator
            </button>
            {running ? (
              <span className="muted">Stop the current session before switching accounts.</span>
            ) : null}
            {showSwitch && !running ? (
              <div className="card" style={{ width: '100%' }}>
                <label>
                  <strong>Replacement account</strong>
                  <br />
                  <select
                    value={switchAccount}
                    onChange={(event) => setSwitchAccount(event.target.value)}
                  >
                    <option value="">Choose an account…</option>
                    {switchCandidates.map((account: ClaudeAccount) => (
                      <option key={account.id} value={account.id}>{account.label}</option>
                    ))}
                  </select>
                </label>
                {accounts.error ? <ErrorState error={accounts.error} /> : null}
                {accounts.data !== null && switchCandidates.length === 0 ? (
                  <p className="muted">No other signed-in, orchestration-capable Claude account is available.</p>
                ) : null}
                <p className="muted">
                  The replacement starts a fresh provider conversation. Requirement, plan, artifacts,
                  events and approvals remain with the run; unrecorded chat context does not transfer.
                </p>
                <div className="stack">
                  <button
                    className="action primary"
                    type="button"
                    disabled={switchAccount === '' || switching}
                    onClick={() => void switchOrchestrator()}
                  >
                    {switching ? 'Switching…' : 'Confirm switch'}
                  </button>
                  <button className="action" type="button" onClick={() => setShowSwitch(false)}>
                    Cancel
                  </button>
                </div>
              </div>
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
            Leaving this run detaches only its viewer; it does not stop the session. Returning to the
            Session tab reconnects automatically and replays the in-memory transcript. Other runs
            continue in parallel for as long as this server runs.
          </p>
        </>
      ) : null}
    </>
  )
}
