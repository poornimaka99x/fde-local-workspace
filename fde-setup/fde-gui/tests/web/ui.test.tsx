// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '../../web/src/components/Markdown'
import { Tabs } from '../../web/src/components/Tabs'
import { ErrorState, Warnings } from '../../web/src/components/States'
import { ApiError } from '../../web/src/lib/api'
import { RunsView } from '../../web/src/features/runs/RunsView'
import { useState } from 'react'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status === 200 ? 'application/json' : 'application/problem+json' },
  })
}

describe('run list states', () => {
  beforeEach(() => {
    window.sessionStorage.setItem('fde-gui-token', 'test-token')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    window.sessionStorage.clear()
  })

  const stubFetch = (handler: (url: string) => Response): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => handler(String(input))),
    )
  }

  it('shows a loading state and then the empty state when there are no runs', async () => {
    stubFetch((url) =>
      url.startsWith('/api/runs')
        ? jsonResponse({ schemaVersion: 1, runs: [], total: 0, returned: 0, warnings: [] })
        : jsonResponse({ schemaVersion: 1, projects: [], unassignedRunCount: 0, warnings: [] }),
    )
    render(<RunsView />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading runs…')
    expect(await screen.findByText(/No runs exist yet/)).toBeInTheDocument()
  })

  it('renders runs, their state and their session honestly', async () => {
    stubFetch((url) =>
      url.startsWith('/api/runs')
        ? jsonResponse({
            schemaVersion: 1,
            total: 1,
            returned: 1,
            warnings: ['runs/broken/manifest.json: malformed manifest.json'],
            runs: [
              {
                runId: '20260902-acme-2-bbbb',
                state: 'complete',
                projectId: null,
                requirement: 'ACME-2 legacy run',
                updatedAt: '2026-09-02T10:00:00+00:00',
                orchestrator: { agentId: 'chatgpt_codex', label: 'ChatGPT/Codex', kind: 'codex' },
                session: {
                  provider: 'codex',
                  profile: null,
                  sessionId: null,
                  resumable: false,
                  resumeReason: 'Resume this run in its original Codex task',
                },
              },
            ],
          })
        : jsonResponse({ schemaVersion: 1, projects: [], unassignedRunCount: 1, warnings: [] }),
    )
    render(<RunsView />)
    const row = await screen.findByRole('row', { name: /20260902-acme-2-bbbb/ })
    expect(within(row).getByText('complete')).toBeInTheDocument()
    expect(within(row).getByText('unassigned')).toBeInTheDocument()
    expect(within(row).getByText(/original Codex task/)).toBeInTheDocument()
    expect(within(row).queryByText('resumable')).not.toBeInTheDocument()
    expect(await screen.findByText(/could not be read cleanly/)).toBeInTheDocument()
  })

  it('offers an orchestrator filter built from every run, not the filtered page', async () => {
    const rows = [
      {
        runId: '20260901-a',
        state: 'research',
        projectId: null,
        requirement: 'one',
        updatedAt: '2026-09-01T10:00:00+00:00',
        orchestrator: { agentId: 'claude_work', label: 'Claude: work', kind: 'claude' },
        session: { provider: 'claude', profile: 'work', sessionId: null, resumable: true, resumeReason: null },
      },
      {
        runId: '20260902-b',
        state: 'complete',
        projectId: null,
        requirement: 'two',
        updatedAt: '2026-09-02T10:00:00+00:00',
        orchestrator: { agentId: 'chatgpt_codex', label: 'ChatGPT/Codex', kind: 'codex' },
        session: { provider: 'codex', profile: null, sessionId: null, resumable: false, resumeReason: 'Resume this run in its original Codex task' },
      },
    ]
    stubFetch((url) => {
      if (!url.startsWith('/api/runs')) {
        return jsonResponse({ schemaVersion: 1, projects: [], unassignedRunCount: 0, warnings: [] })
      }
      // The filtered request returns one row; the options request returns both.
      const filtered = url.includes('orchestrator=')
      const runs = filtered ? [rows[0]] : rows
      return jsonResponse({ schemaVersion: 1, runs, total: rows.length, returned: runs.length, warnings: [] })
    })
    const user = userEvent.setup()
    render(<RunsView />)
    const select = await screen.findByLabelText(/Orchestrator/)
    expect(within(select).getByRole('option', { name: 'ChatGPT/Codex' })).toBeInTheDocument()

    await user.selectOptions(select, 'claude_work')
    await waitFor(() => {
      expect(screen.queryByRole('row', { name: /20260902-b/ })).not.toBeInTheDocument()
    })
    expect(within(select).getByRole('option', { name: 'ChatGPT/Codex' })).toBeInTheDocument()
  })

  it('starts from a search term handed to it by the top bar', async () => {
    let requested = ''
    stubFetch((url) => {
      if (!url.startsWith('/api/runs')) {
        return jsonResponse({ schemaVersion: 1, projects: [], unassignedRunCount: 0, warnings: [] })
      }
      if (url.includes('query=')) requested = url
      return jsonResponse({ schemaVersion: 1, runs: [], total: 3, returned: 0, warnings: [] })
    })
    render(<RunsView initialQuery="ACME-142" />)
    await waitFor(() => expect(requested).toContain('query=ACME-142'))
    expect(await screen.findByDisplayValue('ACME-142')).toBeInTheDocument()
  })

  it('surfaces a server error with a way to retry', async () => {
    stubFetch(() => jsonResponse({ type: 'about:fde/controller-unavailable', title: 'The fde controller is not available.', status: 503 }, 503))
    render(<RunsView />)
    expect(await screen.findByRole('alert')).toHaveTextContent('The fde controller is not available.')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

describe('evidence and refusals', () => {
  it('shows a controller refusal as a refusal, with its own text', () => {
    render(
      <ErrorState
        error={new ApiError(409, 'controller-refused', 'The controller refused this request.', 'fde: nothing has been approved for publication')}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('The controller refused this')
    expect(screen.getByRole('alert')).toHaveTextContent('nothing has been approved for publication')
  })

  it('lists malformed-data warnings instead of blanking the page', () => {
    render(<Warnings warnings={['events.jsonl line 12 is malformed and was not interpreted']} />)
    expect(screen.getByRole('status')).toHaveTextContent('line 12 is malformed')
  })
})

describe('markdown preview', () => {
  it('renders structure without ever producing markup from the source', () => {
    const { container } = render(
      <Markdown source={'# Title\n\n- one\n- two\n\n<img src=x onerror="alert(1)">\n\n`code`'} />,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">')
  })
})

describe('tabs', () => {
  function Harness(): JSX.Element {
    const [active, setActive] = useState('overview')
    return (
      <Tabs
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'events', label: 'Events', badge: 3 },
        ]}
        active={active}
        onSelect={setActive}
      />
    )
  }

  it('moves between tabs with the arrow keys and keeps focus visible', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const overview = screen.getByRole('tab', { name: /Overview/ })
    expect(overview).toHaveAttribute('aria-selected', 'true')
    overview.focus()
    await user.keyboard('{ArrowRight}')
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Events/ })).toHaveAttribute('aria-selected', 'true')
    })
    expect(screen.getByRole('tab', { name: /Events/ })).toHaveFocus()
  })
})
