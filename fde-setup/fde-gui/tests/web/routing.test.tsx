// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewRunForm } from '../../web/src/features/runs/NewRunForm'
import { RoutingMatrix } from '../../web/src/features/runs/RoutingMatrix'
import type { RunStatus } from '../../web/src/lib/types'

/**
 * The routing UI.
 *
 * Three things are asserted throughout: the operator can read the decision and
 * its reasoning with a keyboard alone, nothing in this UI approves anything,
 * and a missing measurement is shown as unavailable rather than as zero.
 */

interface Sent {
  url: string
  method: string
  body: unknown
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  })
}

const accountsResponse = {
  accounts: [{
    id: 'work',
    label: 'Claude: work',
    profile: 'work',
    provider: 'anthropic',
    profilePresent: true,
    authState: 'authenticated',
    authMethod: 'subscription',
    capabilities: [],
    designPanelEligible: false,
    models: [
      { id: 'default', label: 'Account default', efforts: ['auto', 'low', 'medium', 'high'] },
      { id: 'sonnet', label: 'Claude Sonnet', efforts: ['auto', 'low', 'medium', 'high', 'max'] },
    ],
  }, {
    id: 'msc',
    label: 'Claude: msc',
    profile: 'msc',
    provider: 'anthropic',
    profilePresent: false,
    authState: 'login_required',
    authMethod: null,
    capabilities: [],
    designPanelEligible: false,
    models: [{ id: 'sonnet', label: 'Claude Sonnet', efforts: ['auto', 'high'] }],
  }],
}

const policyResponse = {
  capabilities: ['routing.preview', 'routing.status-summary'],
  contracts: ['routing preview --json'],
  policy: {
    state: 'available',
    policyRevision: '2026-09-07.1',
    strategies: ['balanced', 'quality_first', 'cost_first'],
    providers: ['anthropic'],
    costUnitsAreEstimates: true,
    monetaryPricing: 'not configured',
  },
  previewMinRequirementChars: 24,
  strategies: ['balanced', 'quality_first', 'cost_first'],
}

const previewResponse = {
  schemaVersion: 1,
  preview: {
    schemaVersion: 1,
    policyRevision: '2026-09-07.1',
    mode: 'auto',
    strategy: 'balanced',
    assessment: {
      score: 6,
      maxScore: 14,
      band: 'standard',
      confidence: 'high',
      qualityFloor: 'standard',
      dimensions: [
        { id: 'ambiguity', label: 'ambiguity or underspecification', score: 0, evidence: 'names concrete things: export.csv' },
        { id: 'coordination', label: 'cross-system coordination', score: 1, evidence: 'names api' },
      ],
      riskFlags: [{ flag: 'codeChange', floor: 'standard', evidence: 'the plan includes implementation' }],
      overrides: [],
      missingInformation: ['supporting material — no attachment was recorded'],
      clarification: null,
    },
    orchestrator: {
      accountId: 'claude_work',
      accountLabel: 'Claude: work',
      routable: true,
      model: 'sonnet',
      effort: 'medium',
      tier: 'standard',
      qualityFloor: 'standard',
      expectedCostUnits: 4.6,
      reason: 'Claude Sonnet at medium effort is the lowest expected cost that clears the floor',
      strategyRule: 'lowest expected cost at or above the preferred effort',
      limitations: ['thin on novel architecture'],
      escalationCeiling: { tier: 'standard', effort: 'high', maxRetries: 1 },
      alternatives: [{ model: 'opus', effort: 'high', tier: 'premium', expectedCostUnits: 31.05 }],
      rejected: [{ model: 'haiku', effort: 'auto', tier: 'economy', reason: "tier 'economy' is below the 'standard' quality floor" }],
    },
    tasks: [],
    limits: { maxCostUnits: 60, maxRetries: 1, maxAutomaticTier: 'standard', maxAutomaticEffort: 'high' },
    estimatedCostUnits: 4.6,
    costUnitsAreEstimates: true,
    notScheduled: [],
    unroutable: [],
    warnings: [],
    decisionHash: 'sha256:abc',
    overrides: [],
    supersededApprovals: [],
    provisional: true,
    provisionalReason: 'no role assignment exists yet',
  },
}

describe('the new-run routing preview', () => {
  const sent: Sent[] = []

  beforeEach(() => {
    sent.length = 0
    vi.useFakeTimers({ shouldAdvanceTime: true })
    window.sessionStorage.setItem('fde-gui-token', 'test-token')
    window.history.pushState(null, '', '/runs/new')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    window.sessionStorage.clear()
  })

  const stub = (overrides: Record<string, unknown> = {}): void => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method !== undefined && init.method !== 'GET') {
        sent.push({
          url,
          method: init.method,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })
      }
      if (url === '/api/claude/accounts') return jsonResponse(accountsResponse)
      if (url === '/api/routing/policy') return jsonResponse(overrides.policy ?? policyResponse)
      if (url === '/api/routing/preview') {
        const answer = overrides.preview
        if (answer instanceof Response) return answer.clone()
        return jsonResponse(answer ?? previewResponse)
      }
      if (url === '/api/runs' && init?.method === 'POST') {
        return jsonResponse({ schemaVersion: 1, run: { runId: '20260907-acme-1-aaaa' } }, 201)
      }
      return jsonResponse({ schemaVersion: 1, projects: [], unassignedRunCount: 0, warnings: [] })
    }))
  }

  it('offers automatic model and effort as the recommended default', async () => {
    stub()
    render(<NewRunForm />)
    const auto = await screen.findByLabelText(/Automatic model and effort/)
    expect(auto).toBeChecked()
    expect(screen.getByText(/recommended/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Manual/)).not.toBeChecked()
    // Choosing the account stays explicit in both modes.
    expect(screen.getByLabelText(/Orchestrator/)).toBeEnabled()
    // The model and effort are the controller's to choose, and it says so.
    expect(screen.getByLabelText(/Model/)).toBeDisabled()
    expect(screen.getByLabelText(/Effort/)).toBeDisabled()
    expect(screen.getByText(/Switch to Manual to pick them yourself/)).toBeInTheDocument()
  })

  it('continues a design-panel-shaped run into panel configuration', async () => {
    stub()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<NewRunForm />)
    await screen.findByLabelText(/Automatic model and effort/)
    await user.type(screen.getByLabelText(/What do you want done/), 'Rework the returns screen.')
    await user.type(screen.getByLabelText(/Named shape/), 'design-panel')
    await user.click(screen.getByRole('button', { name: /Create run/ }))

    await waitFor(() => expect(window.location.pathname).toBe('/design-panel/new'))
    expect(new URLSearchParams(window.location.search).get('runId'))
      .toBe('20260907-acme-1-aaaa')
  })

  it('offers the three strategies with what each one does', async () => {
    stub()
    render(<NewRunForm />)
    const strategy = await screen.findByLabelText(/Strategy/)
    expect(
      [...strategy.querySelectorAll('option')].map((option) => option.textContent),
    ).toEqual(['Balanced', 'Quality first', 'Cost first'])
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await user.selectOptions(strategy, 'cost_first')
    expect(screen.getByText(/never one below it/)).toBeInTheDocument()
  })

  it('waits for enough of the request before previewing anything', async () => {
    stub()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<NewRunForm />)
    await screen.findByLabelText(/Automatic model and effort/)
    await user.type(screen.getByLabelText(/What do you want done/), 'fix it')
    expect(screen.getByText(/more characters? to go/)).toBeInTheDocument()
    expect(sent.filter((call) => call.url === '/api/routing/preview')).toHaveLength(0)
  })

  it('debounces the preview instead of asking once per keystroke', async () => {
    stub()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<NewRunForm />)
    await screen.findByLabelText(/Automatic model and effort/)
    await user.type(
      screen.getByLabelText(/What do you want done/),
      'ACME-1 add a paginated orders endpoint to the existing API',
    )
    expect(sent.filter((call) => call.url === '/api/routing/preview')).toHaveLength(0)
    vi.advanceTimersByTime(700)
    await waitFor(() =>
      expect(sent.filter((call) => call.url === '/api/routing/preview')).toHaveLength(1))
  })

  it('shows the band, the model, the cost, the confidence and why', async () => {
    stub()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<NewRunForm />)
    await screen.findByLabelText(/Automatic model and effort/)
    await user.type(
      screen.getByLabelText(/What do you want done/),
      'ACME-1 add a paginated orders endpoint to the existing API',
    )
    vi.advanceTimersByTime(700)
    await screen.findByText(/complexity: standard/)
    expect(screen.getByText(/confidence: high/)).toBeInTheDocument()
    expect(screen.getByText('floor: standard')).toBeInTheDocument()
    expect(screen.getByText('sonnet / medium')).toBeInTheDocument()
    expect(screen.getByText(/~4.6 units/)).toBeInTheDocument()
    expect(screen.getByText(/relative units from the routing policy, not money/))
      .toBeInTheDocument()
    // A native disclosure widget, so it needs no ARIA of ours to be reachable.
    const why = screen.getByText('Why this choice?')
    expect(why.tagName).toBe('SUMMARY')
    expect(why.closest('details')).not.toBeNull()
  })

  it('explains itself to a keyboard, in text, without colour', async () => {
    stub()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<NewRunForm />)
    await screen.findByLabelText(/Automatic model and effort/)
    await user.type(
      screen.getByLabelText(/What do you want done/),
      'ACME-1 add a paginated orders endpoint to the existing API',
    )
    vi.advanceTimersByTime(700)
    const why = await screen.findByText('Why this choice?')
    // A real disclosure widget: focusable, and operable with the keyboard.
    why.focus()
    expect(why).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByText(/lowest expected cost that clears the floor/)).toBeInTheDocument()
    expect(screen.getByText(/lowest expected cost at or above the preferred effort/))
      .toBeInTheDocument()
    expect(screen.getByText(/is below the 'standard' quality floor/)).toBeInTheDocument()

    const assessment = await screen.findByText(/How this was assessed/)
    assessment.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByText(/names concrete things: export.csv/)).toBeInTheDocument()
    // Scores are text in a table, not a coloured bar.
    expect(screen.getByRole('row', { name: /ambiguity or underspecification/ }))
      .toBeInTheDocument()
  })

  it('says an account needs signing in rather than routing round it', async () => {
    stub()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<NewRunForm />)
    await screen.findByLabelText(/Automatic model and effort/)
    await user.selectOptions(screen.getByLabelText(/Orchestrator/), 'msc')
    await user.type(
      screen.getByLabelText(/What do you want done/),
      'ACME-1 add a paginated orders endpoint to the existing API',
    )
    vi.advanceTimersByTime(700)
    expect(await screen.findByText(/Sign in to/)).toBeInTheDocument()
    expect(screen.getByText(/will not substitute a different account/)).toBeInTheDocument()
    expect(sent.filter((call) => call.url === '/api/routing/preview')).toHaveLength(0)
  })

  it('shows missing information and a clarification question when there is one', async () => {
    stub({
      preview: {
        ...previewResponse,
        preview: {
          ...previewResponse.preview,
          assessment: {
            ...previewResponse.preview.assessment,
            confidence: 'low',
            clarification: 'State the outcome you want and how you will know it is done.',
          },
          warnings: ['the assessment confidence is low, so the band was raised one tier'],
        },
      },
    })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<NewRunForm />)
    await screen.findByLabelText(/Automatic model and effort/)
    await user.type(
      screen.getByLabelText(/What do you want done/),
      'improve the thing somehow, not sure what exactly',
    )
    vi.advanceTimersByTime(700)
    expect(await screen.findByText(/Worth answering first/)).toBeInTheDocument()
    expect(screen.getByText(/State the outcome you want/)).toBeInTheDocument()
    expect(screen.getByText(/confidence is low/)).toBeInTheDocument()
  })

  it('reports a routing refusal without pretending it has an answer', async () => {
    stub({
      preview: jsonResponse({
        type: 'about:fde/routing-account-unavailable',
        title: 'Claude: work is not available on this machine',
        detail: 'Sign that account in, or choose a different orchestrator.',
      }, 409),
    })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<NewRunForm />)
    await screen.findByLabelText(/Automatic model and effort/)
    await user.type(
      screen.getByLabelText(/What do you want done/),
      'ACME-1 add a paginated orders endpoint to the existing API',
    )
    vi.advanceTimersByTime(700)
    expect(await screen.findByText(/No preview/)).toBeInTheDocument()
    expect(screen.getByText(/is not available on this machine/)).toBeInTheDocument()
  })

  it('never submits or approves on its own', async () => {
    stub()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<NewRunForm />)
    await screen.findByLabelText(/Automatic model and effort/)
    await user.type(
      screen.getByLabelText(/What do you want done/),
      'ACME-1 add a paginated orders endpoint to the existing API',
    )
    vi.advanceTimersByTime(2000)
    await waitFor(() =>
      expect(sent.filter((call) => call.url === '/api/routing/preview')).toHaveLength(1))
    expect(sent.filter((call) => call.url === '/api/runs')).toHaveLength(0)
    expect(JSON.stringify(sent)).not.toContain('APPROVE')
    expect(screen.getByText(/Nothing has been created or approved/)).toBeInTheDocument()
  })

  it('sends the routing mode and the strategy, and no model, when creating the run', async () => {
    stub()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<NewRunForm />)
    await screen.findByLabelText(/Automatic model and effort/)
    await user.selectOptions(screen.getByLabelText(/Strategy/), 'quality_first')
    await user.type(
      screen.getByLabelText(/What do you want done/),
      'ACME-1 add a paginated orders endpoint to the existing API',
    )
    await user.click(screen.getByRole('button', { name: 'Create run' }))
    await waitFor(() =>
      expect(sent.filter((call) => call.url === '/api/runs')).toHaveLength(1))
    const body = sent.find((call) => call.url === '/api/runs')?.body as Record<string, unknown>
    expect(body.routing).toBe('auto')
    expect(body.strategy).toBe('quality_first')
    expect(body.model).toBeUndefined()
    expect(body.effort).toBeUndefined()
  })

  it('does not show a mode as chosen before it knows the answer', async () => {
    // A pending answer is not the same as "unavailable", and showing the
    // recommended option as selected while quietly creating a manual run is the
    // one outcome the brief forbids.
    const held: { release: (() => void) | null } = { release: null }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/claude/accounts') return jsonResponse(accountsResponse)
      if (url === '/api/routing/policy') {
        await new Promise<void>((resolve) => { held.release = resolve })
        return jsonResponse(policyResponse)
      }
      return jsonResponse({ schemaVersion: 1, projects: [], unassignedRunCount: 0, warnings: [] })
    }))
    render(<NewRunForm />)
    expect(await screen.findByText(/Checking whether this controller offers/))
      .toBeInTheDocument()
    expect(screen.getByLabelText(/Automatic model and effort/)).toBeDisabled()
    expect(screen.getByLabelText(/^Manual/)).toBeDisabled()
    expect(screen.getByLabelText(/^Manual/)).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Create run' })).toBeDisabled()
    await waitFor(() => expect(held.release).not.toBeNull())
    held.release?.()
    await waitFor(() =>
      expect(screen.getByLabelText(/Automatic model and effort/)).toBeEnabled())
  })

  it('says so when it cannot ask the controller at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/claude/accounts') return jsonResponse(accountsResponse)
      if (url === '/api/routing/policy') {
        return jsonResponse({
          type: 'about:fde/controller-unavailable',
          title: 'The fde controller is not available.',
        }, 503)
      }
      return jsonResponse({ schemaVersion: 1, projects: [], unassignedRunCount: 0, warnings: [] })
    }))
    render(<NewRunForm />)
    expect(await screen.findByText(/Could not ask the controller about automatic routing/))
      .toBeInTheDocument()
    expect(screen.getByText(/controller is not available/)).toBeInTheDocument()
    // Exactly one mode is selected, and it is the one that still works.
    expect(screen.getByLabelText(/^Manual/)).toBeChecked()
    expect(screen.getByLabelText(/Automatic model and effort/)).not.toBeChecked()
    expect(screen.getByLabelText(/Model/)).toBeEnabled()
  })

  it('says automatic routing is unavailable rather than offering it', async () => {
    stub({
      policy: {
        ...policyResponse,
        policy: {
          state: 'unavailable',
          code: 'routing-policy-invalid',
          message: 'the routing policy is not usable: it is not valid JSON',
        },
      },
    })
    render(<NewRunForm />)
    expect(await screen.findByText(/Automatic routing is unavailable/)).toBeInTheDocument()
    expect(screen.getByText(/not valid JSON/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Automatic model and effort/)).toBeDisabled()
    expect(screen.getByLabelText(/^Manual/)).toBeChecked()
    expect(screen.getByLabelText(/Model/)).toBeEnabled()
  })
})

// -- the run view ---------------------------------------------------------

const matrixRouting = {
  schemaVersion: 1,
  runId: '20260907-acme-1-aaaa',
  routing: {
    ...previewResponse.preview,
    approvedAt: '2026-09-07T11:00:00+00:00',
    tasks: [
      {
        taskId: 'solutioning-1',
        stage: 'solutioning',
        stageLabel: 'solution architecture',
        objective: 'produce architecture options with their costs, and an ADR',
        requiredRole: 'solutioning',
        roleLabel: 'Solution architect',
        specialist: 'solutioner',
        specialistReason: 'a focused solutioner method, run by a separate account',
        discretionary: false,
        accountId: 'claude_msc',
        accountLabel: 'Claude: msc',
        accountAvailable: true,
        provider: 'anthropic',
        routable: true,
        model: 'sonnet',
        effort: 'high',
        tier: 'standard',
        qualityFloor: 'high',
        band: 'complex',
        dependsOn: ['intake-1'],
        parallelizable: false,
        estimatedCostUnits: 11.88,
        escalationCeiling: { tier: 'premium', effort: 'high', maxRetries: 1 },
        alternatives: [],
        rejected: [],
        independence: null,
        progress: {
          taskId: 'solutioning-1', attempts: 1, retries: 0, escalations: 0,
          attemptsAtCurrentRung: 1, lastOutcome: 'fail',
          lastClassification: 'invalid-contract', spentCostUnits: 11.88, maxRetries: 1,
        },
      },
      {
        taskId: 'review-1',
        stage: 'review',
        stageLabel: 'adversarial review',
        objective: 'check this critical work independently of whoever produced it',
        requiredRole: 'review',
        roleLabel: 'Reviewer(s)',
        specialist: 'reviewer',
        specialistReason: 'critical work needs a check that did not come from the producer',
        discretionary: false,
        accountId: 'claude_work',
        accountLabel: 'Claude: work',
        accountAvailable: true,
        provider: 'anthropic',
        routable: true,
        model: 'sonnet',
        effort: 'high',
        tier: 'standard',
        qualityFloor: 'high',
        band: 'complex',
        dependsOn: [],
        parallelizable: false,
        estimatedCostUnits: 11.88,
        escalationCeiling: { tier: 'premium', effort: 'high', maxRetries: 1 },
        alternatives: [],
        rejected: [],
        independence: {
          independent: false,
          of: ['claude_work'],
          reason: "shares the producer's account and conversation lineage",
          requiresDegradedApproval: true,
        },
        progress: null,
      },
    ],
    overrides: [{
      at: '2026-09-07T12:00:00+00:00',
      operator: 'operator',
      target: 'task:solutioning-1',
      field: 'model',
      from: 'sonnet',
      to: 'opus',
      reason: 'an auth design needs the stronger model',
      escalation: true,
      previousDecisionHash: 'sha256:abc',
      decisionHash: 'sha256:def',
    }],
  },
  summary: null,
}

const matrixAttempts = {
  schemaVersion: 1,
  runId: '20260907-acme-1-aaaa',
  attempts: [{
    at: '2026-09-07T11:30:00+00:00',
    taskId: 'solutioning-1',
    attempt: 1,
    mode: 'initial',
    model: 'sonnet',
    effort: 'high',
    tier: 'standard',
    estimatedCostUnits: 11.88,
    outcome: 'fail',
    classification: 'invalid-contract',
    usage: {},
    notes: [],
    evidence: [],
  }],
  ledger: [],
  progress: [],
  spentCostUnits: 11.88,
  approvedCostUnits: 60,
  costUnitsAreEstimates: true,
  usage: {
    inputTokens: { state: 'unavailable', value: null, reason: 'no provider reported this figure' },
    durationMs: { state: 'reported', value: 4200, source: 'measured by the controller' },
    estimatedCostUnits: { state: 'estimated', value: 11.88, source: 'policy cost weights' },
  },
}

function runWithRouting(overrides: Record<string, unknown> = {}): RunStatus {
  return {
    runId: '20260907-acme-1-aaaa',
    routing: {
      present: true,
      readable: true,
      approved: true,
      planHashMatches: true,
      taskCount: 2,
      riskFlags: [],
      missingInformation: [],
      tasks: [],
      notScheduled: [],
      unroutable: [],
      warnings: [],
      usage: {},
      spentCostUnits: 11.88,
      ...overrides,
    },
  } as unknown as RunStatus
}

describe('the run view execution matrix', () => {
  beforeEach(() => {
    window.sessionStorage.setItem('fde-gui-token', 'test-token')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    window.sessionStorage.clear()
  })

  const stub = (routing: unknown = matrixRouting, attempts: unknown = matrixAttempts): void => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/routing')) return jsonResponse(routing)
      if (url.includes('/routing/attempts')) return jsonResponse(attempts)
      if (url.includes('/routing/explain')) {
        return jsonResponse({
          schemaVersion: 1,
          runId: '20260907-acme-1-aaaa',
          policyRevision: '2026-09-07.1',
          policyRevisionOnDisk: '2026-09-07.1',
          policyDrift: null,
          assessment: previewResponse.preview.assessment,
          target: { taskId: 'solutioning-1', limitations: ['thin on novel architecture'] },
          alternativesConsidered: [
            { model: 'opus', effort: 'high', tier: 'premium', expectedCostUnits: 31.05 },
          ],
          rejected: [
            { model: 'haiku', effort: 'auto', tier: 'economy', reason: 'below the floor' },
          ],
          notScheduled: [],
        })
      }
      if (url === '/api/claude/accounts') return jsonResponse(accountsResponse)
      return jsonResponse({})
    }))
  }

  it('keeps identity, method, model and effort as four separate columns', async () => {
    stub()
    render(<RoutingMatrix run={runWithRouting()} />)
    const table = await screen.findByRole('table', { name: /four separate choices/ })
    const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent)
    expect(headers).toEqual([
      'Task', 'Stage', 'Role', 'Specialist method', 'Account identity',
      'Model / effort', 'Floor', 'Est. cost',
    ])
    const row = within(table).getByRole('row', { name: /solutioning-1/ })
    expect(within(row).getByText('solutioner')).toBeInTheDocument()
    expect(within(row).getByText('Claude: msc')).toBeInTheDocument()
    expect(within(row).getByText('sonnet / high')).toBeInTheDocument()
  })

  it('states degraded independence in words', async () => {
    stub()
    render(<RoutingMatrix run={runWithRouting()} />)
    await screen.findByText(/degraded independence/)
    expect(screen.getByText(/This check is not independent/)).toBeInTheDocument()
    expect(screen.getByText(/shares the producer's account/)).toBeInTheDocument()
    expect(screen.getByText(/degraded-operation approval applies/)).toBeInTheDocument()
  })

  it('shows the approved ceilings against what has been spent', async () => {
    stub()
    render(<RoutingMatrix run={runWithRouting()} />)
    await screen.findByText('Approved ceilings')
    const row = screen.getByRole('row', { name: /Cost units/ })
    expect(within(row).getByText(/~11.9 units/)).toBeInTheDocument()
    expect(within(row).getByText(/60 approved/)).toBeInTheDocument()
    expect(within(row).getByText(/not money/)).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /Retries/ })).toHaveTextContent('1 per task')
  })

  it('shows overrides and the reason each one was made', async () => {
    stub()
    const user = userEvent.setup()
    render(<RoutingMatrix run={runWithRouting()} />)
    const summary = await screen.findByText(/Overrides and superseded approvals/)
    await user.click(summary)
    expect(screen.getByText('operator')).toBeInTheDocument()
    expect(screen.getByText(/an auth design needs the stronger model/)).toBeInTheDocument()
    expect(screen.getByText(/raised what was approved/)).toBeInTheDocument()
  })

  it('renders an unavailable measurement as unavailable, never as zero', async () => {
    stub()
    render(<RoutingMatrix run={runWithRouting()} />)
    await screen.findByText('Usage')
    const tokens = screen.getByText('Input tokens').closest('div')
    expect(tokens).not.toBeNull()
    expect(within(tokens as HTMLElement).getByText('unavailable')).toBeInTheDocument()
    expect(within(tokens as HTMLElement).getByText(/no provider reported this figure/))
      .toBeInTheDocument()
    expect(tokens?.textContent).not.toMatch(/\b0\b/)
    const duration = screen.getByText('Duration (ms)').closest('div')
    expect(within(duration as HTMLElement).getByText('4200')).toBeInTheDocument()
    expect(within(duration as HTMLElement).getByText('reported')).toBeInTheDocument()
  })

  it('loads the full explanation only when a task is opened', async () => {
    stub()
    const user = userEvent.setup()
    render(<RoutingMatrix run={runWithRouting()} />)
    const summary = await screen.findByText(/solutioning-1/, { selector: 'summary span' })
    // The refusal reason is unique to the explain payload, so its absence shows
    // the request has not been made.
    expect(screen.queryByText(/below the floor/)).not.toBeInTheDocument()
    await user.click(summary)
    const task = summary.closest('details') as HTMLElement
    await waitFor(() =>
      expect(within(task).getByText('Why this choice?')).toBeInTheDocument())
    await user.click(within(task).getByText('Why this choice?'))
    await waitFor(() =>
      expect(within(task).getByText(/below the floor/)).toBeInTheDocument())
  })

  it('offers an override that needs a reason and never fills in the phrase', async () => {
    stub()
    const user = userEvent.setup()
    render(<RoutingMatrix run={runWithRouting()} />)
    const summary = await screen.findByText(/solutioning-1/, { selector: 'summary span' })
    await user.click(summary)
    const task = summary.closest('details') as HTMLElement
    await user.click(within(task).getByText('Override this decision'))
    const button = within(task).getByRole('button', { name: 'Record override' })
    expect(button).toBeDisabled()
    await user.type(
      within(task).getByLabelText(/Reason/), 'the reviewer needs the stronger model')
    expect(button).toBeEnabled()
    const phrase = within(task).getByLabelText(/Approval phrase/) as HTMLInputElement
    expect(phrase.value).toBe('')
    expect(within(task).getByText(/A quality floor is not negotiable by override/))
      .toBeInTheDocument()
  })

  it('says a plan that moved after approval needs re-approving', async () => {
    stub()
    render(<RoutingMatrix run={runWithRouting({ planHashMatches: false })} />)
    expect(await screen.findByText(/plan or roles changed after this route was approved/))
      .toBeInTheDocument()
    expect(screen.getByText(/--reapprove/)).toBeInTheDocument()
  })

  it('says a manual run is manual rather than showing an empty matrix', async () => {
    stub()
    render(<RoutingMatrix run={{ runId: 'r', routing: null } as unknown as RunStatus} />)
    expect(await screen.findByText(/selects its model and effort manually/))
      .toBeInTheDocument()
  })

  it('reports an unreadable routing record instead of guessing', async () => {
    stub()
    render(<RoutingMatrix run={runWithRouting({
      readable: false,
      message: 'routing record is not schema 1',
    })} />)
    expect(await screen.findByText(/could not be read/)).toBeInTheDocument()
    expect(screen.getByText(/not schema 1/)).toBeInTheDocument()
  })

  it('shows an unknown retry ceiling as unknown, not as zero', async () => {
    stub({
      ...matrixRouting,
      routing: {
        ...matrixRouting.routing,
        limits: { maxCostUnits: 60, maxAutomaticTier: 'standard', maxAutomaticEffort: 'high' },
        tasks: [{
          ...matrixRouting.routing.tasks[0],
          escalationCeiling: { tier: 'premium', effort: 'high', maxRetries: null },
        }],
      },
    })
    render(<RoutingMatrix run={runWithRouting()} />)
    await screen.findByText('Approved ceilings')
    expect(screen.getByRole('row', { name: /Retries/ })).toHaveTextContent('not recorded')
    expect(screen.getByRole('row', { name: /Retries/ })).not.toHaveTextContent('0 per task')
    expect(screen.getByText(/retry count not recorded/)).toBeInTheDocument()
  })

  it('shows the append-only ledger behind the replayed attempts', async () => {
    stub(matrixRouting, {
      ...matrixAttempts,
      ledger: [
        { ...matrixAttempts.attempts[0], classification: null, outcome: 'fail' },
        {
          ...matrixAttempts.attempts[0],
          at: '2026-09-07T11:35:00+00:00',
          supersedes: { attempt: 1 },
          recordedBy: 'operator',
        },
      ],
    })
    const user = userEvent.setup()
    render(<RoutingMatrix run={runWithRouting()} />)
    await user.click(await screen.findByText(/^Attempts \(/))
    await user.click(screen.getByText(/Full ledger \(2 lines\)/))
    expect(screen.getByText(/attempt 1 recorded/)).toBeInTheDocument()
    expect(screen.getByText(/attempt 1 judged.*invalid-contract.*by operator/))
      .toBeInTheDocument()
    expect(screen.getByText(/Nothing here was\s+rewritten/)).toBeInTheDocument()
  })

  it('has no control that approves a plan', async () => {
    stub()
    render(<RoutingMatrix run={runWithRouting()} />)
    await screen.findByText('Approved ceilings')
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(/approve/i)
    }
    // What it says instead: the route is already frozen, and that freeze is what
    // every invocation is checked against.
    expect(screen.getByText(/Every\s+invocation is checked against it/))
      .toBeInTheDocument()
  })
})
