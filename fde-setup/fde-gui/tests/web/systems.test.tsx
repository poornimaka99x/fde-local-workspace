// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewFdeRunForm, SystemsView } from '../../web/src/features/systems/FdeSystemViews'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const configuration = {
  schemaVersion: 1, id: 'default-forward-deployed-engineer', version: 1,
  systemType: 'forward-deployed-engineer', executorType: 'forward-deployed-engineer',
  name: 'Default Forward Deployed Engineer', description: 'Complete lifecycle', enabled: true,
  projectId: null, repository: null, workspace: null, artifactRoot: 'docs/fde', orchestrator: 'work', reviewer: null,
  routing: 'auto', strategy: 'balanced', model: 'default', effort: 'auto',
  stages: Array.from({ length: 9 }, (_, index) => ({ id: `stage-${index}`, label: `Stage ${index + 1}`, enabled: true, primaryAccount: null, reviewerAccount: null, approvalRequired: true, capabilityOverrides: {} })),
  governance: { approvalAfterEveryStage: true, approvalBeforeCodeChanges: true, approvalBeforeDeployment: true, approvalBeforeProductionMutation: true, stopOnAmbiguity: true },
  createdAt: '2026-09-11T10:00:00Z', updatedAt: '2026-09-11T10:00:00Z',
}

beforeEach(() => {
  window.sessionStorage.setItem('fde-gui-token', 'test-token')
  window.history.pushState(null, '', '/systems')
})
afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear() })

describe('Forward Deployed Engineer GUI', () => {
  it('shows a first-class system card with configure, start, and history actions', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/system-types') return json({ schemaVersion: 1, systemTypes: [{ id: 'forward-deployed-engineer', name: 'Forward Deployed Engineer', shortName: 'FDE', description: 'Human-governed delivery.', executorType: 'forward-deployed-engineer', lifecycle: configuration.stages }] })
      if (url === '/api/system-configurations') return json({ schemaVersion: 1, configurations: [configuration] })
      return json({ schemaVersion: 1, runs: [], total: 0, warnings: [] })
    }))
    render(<SystemsView />)
    const card = await screen.findByRole('article')
    expect(within(card).getByRole('heading', { name: 'Forward Deployed Engineer' })).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Start run' })).toHaveAttribute('href', '/systems/forward-deployed-engineer/new')
    expect(within(card).getByRole('link', { name: 'Configure' })).toHaveAttribute('href', '/systems/forward-deployed-engineer')
    expect(within(card).getByRole('link', { name: 'View runs' })).toHaveAttribute('href', '/systems/forward-deployed-engineer/runs')
  })

  it('reviews the resolved lifecycle before calling the dedicated run endpoint', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/system-configurations') return json({ schemaVersion: 1, configurations: [configuration] })
      if (url === '/api/projects') return json({ schemaVersion: 1, projects: [], unassignedRunCount: 0, warnings: [] })
      if (url === '/api/claude/accounts') return json({ accounts: [{ id: 'work', label: 'Claude: work', provider: 'anthropic', profile: 'work', profilePresent: true, authState: 'authenticated', authMethod: null, models: [], capabilities: ['orchestration'], orchestratorEligible: true, designPanelEligible: false }] })
      if (url === '/api/fde-runs' && init?.method === 'POST') return json({ run: { runId: 'fde-run-1' } }, 201)
      return json({}, 404)
    })
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    render(<NewFdeRunForm />)
    await user.type(await screen.findByLabelText('Business intent'), 'Improve checkout conversion safely.')
    await user.click(screen.getByRole('button', { name: 'Review run' }))
    expect(await screen.findByText('Review before starting')).toBeInTheDocument()
    expect(screen.getAllByText(/primary → independent review → approval/)).toHaveLength(9)
    await user.click(screen.getByRole('button', { name: 'Start Forward Deployed Engineer Run' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/fde-runs', expect.objectContaining({ method: 'POST' })))
    expect(window.location.pathname).toBe('/systems/forward-deployed-engineer/runs/fde-run-1')
  })
})
