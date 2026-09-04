// @vitest-environment jsdom
import { forwardRef, useImperativeHandle } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const written: string[] = []

// The xterm surface is replaced: this file is about what the panel does, not
// about how a terminal renders.
vi.mock('../../web/src/components/TerminalView', () => ({
  TerminalView: forwardRef<{ write: (data: string) => void; focus: () => void }, unknown>(
    function FakeTerminalView(_props, ref) {
      useImperativeHandle(ref, () => ({
        write: (data: string) => written.push(data),
        focus: () => undefined,
      }))
      return <div data-testid="terminal" />
    },
  ),
}))

const { SessionPanel } = await import('../../web/src/features/runs/SessionPanel')
import type { RunStatus } from '../../web/src/lib/types'

class FakeSocket {
  static instances: FakeSocket[] = []
  static OPEN = 1
  readyState = 1
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
    this.onclose?.()
  }
  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

function runFixture(overrides: Partial<RunStatus> = {}): RunStatus {
  return {
    schemaVersion: 1,
    runId: '20260903-max-1-aaaa',
    dir: '/tmp/run',
    manifest: {},
    state: 'research',
    blockedFrom: null,
    projectId: null,
    project: null,
    requirement: { summary: 'do the thing', jiraKey: null, hasFile: true, path: 'requirement.md' },
    plan: null,
    planLine: null,
    stageTimeline: [],
    sequence: [],
    nextState: null,
    nextAction: null,
    roles: {
      confirmed: true,
      confirmedAt: null,
      selectedAt: null,
      orchestrator: { agentId: 'claude_work', label: 'Claude: work', kind: 'claude' },
      assignments: [],
    },
    approvals: [],
    checkpoints: [],
    events: { total: 0, offset: 0, limit: 50, returned: 0, nextCursor: null, items: [] },
    artifacts: { expected: [], discovered: [], truncated: false },
    attachments: [],
    outputHygiene: null,
    session: { provider: 'claude', profile: 'work', sessionId: null, resumable: true, resumeReason: null },
    warnings: [],
    ...overrides,
  } as RunStatus
}

describe('the session panel', () => {
  const posted: { url: string; body: unknown }[] = []

  beforeEach(() => {
    written.length = 0
    posted.length = 0
    FakeSocket.instances = []
    window.sessionStorage.setItem('fde-gui-token', 'test-token')
    vi.stubGlobal('WebSocket', FakeSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    window.sessionStorage.clear()
  })

  const stubFetch = (sessionState: unknown, onPost?: (url: string) => unknown): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (init?.method === 'POST') {
          posted.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null })
          return new Response(JSON.stringify(onPost?.(url) ?? {}), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(JSON.stringify(sessionState), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
  }

  it('will not offer to resume a Codex-led run', async () => {
    stubFetch({ available: true, session: null })
    render(
      <SessionPanel
        run={runFixture({
          session: {
            provider: 'codex',
            profile: null,
            sessionId: null,
            resumable: false,
            resumeReason: 'Resume this run in its original Codex task',
          },
        })}
      />,
    )
    expect(await screen.findByText('Resume this run in its original Codex task')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Resume session/ })).not.toBeInTheDocument()
    expect(screen.getByText(/will not invent a resume path/)).toBeInTheDocument()
  })

  it('says so plainly when the installation has no terminal backend', async () => {
    stubFetch({ available: false, session: null })
    render(<SessionPanel run={runFixture()} />)
    expect(await screen.findByText(/no terminal backend/)).toBeInTheDocument()
    expect(screen.getByText('fde-start --resume 20260903-max-1-aaaa')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Resume session/ })).not.toBeInTheDocument()
  })

  it('resumes, attaches to the stream and replays the screen', async () => {
    stubFetch({ available: true, session: null }, () => ({
      status: 'started',
      ticket: 'ticket-abc',
      session: {
        runId: '20260903-max-1-aaaa',
        status: 'running',
        pid: 4242,
        startedAt: '2026-09-03T10:00:00+00:00',
        exitedAt: null,
        exitCode: null,
        cwd: '/tmp/repo',
        command: ['/bin/fde-start', '--resume', '20260903-max-1-aaaa'],
        envKeys: ['HOME', 'PATH'],
        stopRequestedAt: null,
        attachedClients: 0,
      },
    }))
    const user = userEvent.setup()
    render(<SessionPanel run={runFixture()} />)

    await user.click(await screen.findByRole('button', { name: 'Resume session' }))

    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
    const socket = FakeSocket.instances[0]
    expect(socket?.url).toContain('/api/runs/20260903-max-1-aaaa/session/terminal?ticket=ticket-abc')
    expect(posted[0]?.url).toContain('/session/resume')

    act(() => socket?.deliver({ type: 'ready', backlog: 'scoping the run\r\n', session: {} }))
    expect(written).toContain('scoping the run\r\n')

    act(() => socket?.deliver({ type: 'output', data: 'more output' }))
    expect(written).toContain('more output')

    expect(await screen.findByText('pid 4242', { exact: false })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()

    act(() => socket?.deliver({ type: 'exit', exitCode: 0 }))
    expect(await screen.findByText(/exited with code 0/)).toBeInTheDocument()
  })

  it('interrupts first, and only force-stops behind a confirmation', async () => {
    {
      const running = {
        runId: '20260903-max-1-aaaa',
        status: 'running',
        pid: 99,
        startedAt: '2026-09-03T10:00:00+00:00',
        exitedAt: null,
        exitCode: null,
        cwd: '/tmp/repo',
        command: [],
        envKeys: [],
        stopRequestedAt: null,
        attachedClients: 1,
      }
      stubFetch({ available: true, session: running }, () => running)
      const user = userEvent.setup()
      render(<SessionPanel run={runFixture()} forceStopDelayMs={10} />)

      await user.click(await screen.findByRole('button', { name: 'Stop' }))
      expect(posted.at(-1)).toMatchObject({ body: { force: false } })
      const force = await screen.findByRole('button', { name: 'Force stop' })

      vi.stubGlobal('confirm', vi.fn(() => false))
      await user.click(force)
      expect(posted.filter((call) => (call.body as { force?: boolean }).force === true)).toHaveLength(0)

      vi.stubGlobal('confirm', vi.fn(() => true))
      await user.click(force)
      expect(posted.at(-1)).toMatchObject({ body: { force: true } })
    }
  })

  it('detaches on unmount without stopping the session', async () => {
    const running = {
      runId: '20260903-max-1-aaaa',
      status: 'running',
      pid: 7,
      startedAt: '2026-09-03T10:00:00+00:00',
      exitedAt: null,
      exitCode: null,
      cwd: '/tmp/repo',
      command: [],
      envKeys: [],
      stopRequestedAt: null,
      attachedClients: 1,
    }
    stubFetch({ available: true, session: running }, () => ({ status: 'existing', ticket: 't', session: running }))
    const user = userEvent.setup()
    const view = render(<SessionPanel run={runFixture()} />)
    await screen.findByRole('button', { name: 'Stop' })
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    posted.length = 0

    view.unmount()
    expect(posted.filter((call) => call.url.includes('/session/stop'))).toHaveLength(0)
  })
})
