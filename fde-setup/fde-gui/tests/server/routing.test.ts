import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authed, makeHarness, type Harness } from './harness'

/**
 * The routing API.
 *
 * Every test asserts one of three things: the console calls a controller JSON
 * command rather than deciding anything, it never writes a routing file, and it
 * never clears an approval gate on the operator's behalf.
 */

const RUN = '20260907-max-142-abcd'

const decision = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  policyRevision: '2026-09-07.1',
  mode: 'auto',
  strategy: 'balanced',
  effectiveBand: 'standard',
  limitBand: 'complex',
  assessment: {
    score: 6,
    maxScore: 14,
    band: 'standard',
    bandFromScore: 'standard',
    confidence: 'high',
    qualityFloor: 'standard',
    riskFloor: 'standard',
    strictestStageFloor: 'high',
    dimensions: [
      { id: 'scopeBreadth', label: 'scope breadth', score: 1, evidence: '3 stages planned' },
      { id: 'ambiguity', label: 'ambiguity', score: 0, evidence: 'names concrete things' },
    ],
    riskFlags: [{ flag: 'codeChange', floor: 'standard', evidence: 'plan includes implementation' }],
    overrides: [],
    missingInformation: [],
    clarification: null,
  },
  orchestrator: {
    accountId: 'claude_work',
    account: 'work',
    provider: 'anthropic',
    routable: true,
    model: 'sonnet',
    modelLabel: 'Claude Sonnet',
    effort: 'medium',
    tier: 'standard',
    qualityFloor: 'standard',
    costUnits: 4,
    expectedCostUnits: 4.6,
    reason: 'Claude Sonnet at medium effort is the lowest expected cost that clears the floor',
    strategyRule: 'lowest expected cost at or above the preferred effort',
    escalationCeiling: { tier: 'standard', effort: 'high', maxRetries: 1, rungsAbove: 1 },
    alternatives: [{ model: 'opus', effort: 'high', tier: 'premium', costUnits: 27, expectedCostUnits: 31.05 }],
    rejected: [{ model: 'haiku', effort: 'auto', tier: 'economy', reason: "tier 'economy' is below the floor" }],
  },
  tasks: [
    {
      taskId: 'solutioning-1',
      stage: 'solutioning',
      stageLabel: 'solution architecture',
      objective: 'produce architecture options',
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
      escalationCeiling: { tier: 'premium', effort: 'high', maxRetries: 1, rungsAbove: 1 },
      alternatives: [],
      rejected: [],
      independence: null,
      progress: {
        taskId: 'solutioning-1', attempts: 0, retries: 0, escalations: 0,
        attemptsAtCurrentRung: 0, spentCostUnits: 0, maxRetries: 1,
      },
    },
  ],
  limits: {
    maxSpecialists: 8, maxSpecialistsPerStage: 2, maxParallel: 3, maxRetries: 1,
    maxCostUnits: 180, maxAutomaticTier: 'premium', maxAutomaticEffort: 'high',
    requireIndependentReview: false,
  },
  estimatedCostUnits: 16.48,
  costUnitsAreEstimates: true,
  notScheduled: [],
  unroutable: [],
  warnings: [],
  specialistCount: 1,
  discretionaryCount: 0,
  decisionHash: 'sha256:abc',
  proposedAt: '2026-09-07T10:00:00+00:00',
  approvedAt: null,
  approvedWithPlanHash: null,
  overrides: [],
  ...overrides,
})

describe('the routing API', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await makeHarness({ withDesignRegistry: true })
  })

  afterEach(async () => {
    await harness.destroy()
  })

  const post = async (url: string, payload: Record<string, unknown>) =>
    await harness.app.inject({
      method: 'POST',
      url,
      headers: { ...authed(harness.token), origin: 'http://127.0.0.1:7317' },
      payload,
    })

  const get = async (url: string) =>
    await harness.app.inject({ method: 'GET', url, headers: authed(harness.token) })

  // -- feature detection -------------------------------------------------

  it('reports what the controller can be asked, from the controller', async () => {
    harness.fixture('version', {
      schemaVersion: 1,
      toolkit: 'fde-core',
      contracts: ['routing preview --json'],
      capabilities: ['routing.preview', 'routing.status-summary'],
      routingPolicy: {
        state: 'available', policyRevision: '2026-09-07.1', schemaVersion: 1,
        strategies: ['balanced', 'quality_first', 'cost_first'],
        providers: ['anthropic', 'codex'], costUnitsAreEstimates: true,
        monetaryPricing: 'not configured',
      },
    })
    const response = await get('/api/routing/policy')
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      capabilities: string[]
      policy: { state: string; policyRevision: string; monetaryPricing: string }
      previewMinRequirementChars: number
      strategies: string[]
    }
    expect(body.capabilities).toContain('routing.preview')
    expect(body.policy.state).toBe('available')
    expect(body.policy.monetaryPricing).toBe('not configured')
    expect(body.strategies).toEqual(['balanced', 'quality_first', 'cost_first'])
    expect(body.previewMinRequirementChars).toBeGreaterThan(0)
  })

  it('says automatic routing is unavailable rather than failing', async () => {
    harness.fixture('version', {
      schemaVersion: 1, toolkit: 'fde-core', contracts: [], capabilities: [],
      routingPolicy: { state: 'unavailable', code: 'routing-policy-invalid', message: 'broken' },
    })
    const response = await get('/api/routing/policy')
    expect(response.statusCode).toBe(200)
    expect((response.json() as { policy: { state: string } }).policy.state).toBe('unavailable')
  })

  // -- preview -----------------------------------------------------------

  it('sends the request text to the controller stdin, never to argv', async () => {
    harness.fixture('routing-preview', { schemaVersion: 1, preview: decision() })
    const requirement = '--dangerously-looking request that also happens to be long enough'
    const response = await post('/api/routing/preview', {
      orchestrator: 'work', strategy: 'balanced', requirement,
    })
    expect(response.statusCode).toBe(200)
    const call = harness.calls().find((args) => args[0] === 'routing' && args[1] === 'preview')
    expect(call).toBeDefined()
    expect(call).toContain('--requirement-stdin')
    expect(call).not.toContain(requirement)
    expect(harness.stdinFor('routing-preview')?.toString('utf8')).toBe(requirement)
  })

  it('returns the controller decision, validated', async () => {
    harness.fixture('routing-preview', { schemaVersion: 1, preview: decision() })
    const response = await post('/api/routing/preview', {
      orchestrator: 'work', requirement: 'Add a paginated orders endpoint to the API.',
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { preview: { assessment: { band: string }; tasks: unknown[] } }
    expect(body.preview.assessment.band).toBe('standard')
    expect(body.preview.tasks).toHaveLength(1)
  })

  it('waits for enough of the request rather than assessing half a sentence', async () => {
    const response = await post('/api/routing/preview', {
      orchestrator: 'work', requirement: 'fix it',
    })
    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('requirement-too-short')
    expect(harness.calls().some((args) => args[1] === 'preview')).toBe(false)
  })

  it('refuses a shape and a stage list together', async () => {
    const response = await post('/api/routing/preview', {
      orchestrator: 'work', requirement: 'Add a paginated orders endpoint to the API.',
      shape: 'build', stages: ['intake'],
    })
    expect(response.statusCode).toBe(400)
  })

  it('refuses an account this console never offered', async () => {
    const response = await post('/api/routing/preview', {
      orchestrator: 'not-a-real-account',
      requirement: 'Add a paginated orders endpoint to the API.',
    })
    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('unknown-account')
  })

  it('passes the controller typed refusal through as itself', async () => {
    harness.failure('routing-preview', 3, JSON.stringify({
      schemaVersion: 1,
      error: {
        code: 'routing-account-unavailable',
        message: 'Claude: msc is not available on this machine',
        hint: 'Sign that account in, or choose a different orchestrator.',
      },
    }))
    const response = await post('/api/routing/preview', {
      orchestrator: 'msc', requirement: 'Add a paginated orders endpoint to the API.',
    })
    expect(response.statusCode).toBe(409)
    const body = response.json() as { title: string; detail?: string }
    expect(response.body).toContain('routing-account-unavailable')
    expect(body.detail).toContain('Sign that account in')
  })

  it('never asks the controller to approve anything', async () => {
    harness.fixture('routing-preview', { schemaVersion: 1, preview: decision() })
    await post('/api/routing/preview', {
      orchestrator: 'work', requirement: 'Add a paginated orders endpoint to the API.',
    })
    for (const call of harness.calls()) {
      expect(call).not.toContain('approve-plan')
      expect(call.join(' ')).not.toContain('APPROVE')
    }
  })

  // -- show, explain, attempts -------------------------------------------

  it('shows a run route through the controller', async () => {
    harness.fixture(`routing-show-${RUN}`, {
      schemaVersion: 1, runId: RUN, routing: decision({ approvedAt: '2026-09-07T11:00:00+00:00' }),
    })
    const response = await get(`/api/runs/${RUN}/routing`)
    expect(response.statusCode).toBe(200)
    const body = response.json() as { routing: { approvedAt: string } }
    expect(body.routing.approvedAt).toBe('2026-09-07T11:00:00+00:00')
  })

  it('answers 404 for a run with no routing record', async () => {
    harness.failure(`routing-show-${RUN}`, 4, JSON.stringify({
      schemaVersion: 1,
      error: { code: 'routing-absent', message: 'no routing record', hint: 'create one' },
    }))
    const response = await get(`/api/runs/${RUN}/routing`)
    expect(response.statusCode).toBe(404)
    expect(response.body).toContain('routing-absent')
  })

  it('refuses an unusable run id before calling anything', async () => {
    const response = await get('/api/runs/..%2Fetc/routing')
    expect(response.statusCode).toBe(400)
    expect(harness.calls().some((args) => args[0] === 'routing')).toBe(false)
  })

  it('explains one task and forwards only a valid task id', async () => {
    harness.fixture(`routing-explain-${RUN}`, {
      schemaVersion: 1, runId: RUN, policyRevision: '2026-09-07.1',
      policyRevisionOnDisk: '2026-09-07.1', policyDrift: null,
      assessment: decision().assessment,
      target: { taskId: 'solutioning-1', model: 'sonnet', effort: 'high', tier: 'standard' },
      alternativesConsidered: [], rejected: [], notScheduled: [],
    })
    const ok = await get(`/api/runs/${RUN}/routing/explain?taskId=solutioning-1`)
    expect(ok.statusCode).toBe(200)
    const call = harness.calls().find((args) => args[1] === 'explain')
    expect(call).toContain('--task-id')
    expect(call).toContain('solutioning-1')
    const bad = await get(`/api/runs/${RUN}/routing/explain?taskId=../../etc/passwd`)
    expect(bad.statusCode).toBe(400)
  })

  it('reads the attempt ledger without changing it', async () => {
    harness.fixture(`routing-attempts-${RUN}`, {
      schemaVersion: 1, runId: RUN, attempts: [], ledger: [], progress: [],
      spentCostUnits: 11.88, approvedCostUnits: 180, costUnitsAreEstimates: true,
      usage: {
        inputTokens: { state: 'unavailable', value: null, reason: 'no provider reported it' },
        estimatedCostUnits: { state: 'estimated', value: 11.88, source: 'policy weights' },
      },
    })
    const response = await get(`/api/runs/${RUN}/routing/attempts`)
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      usage: Record<string, { state: string; value: unknown } | undefined>
      spentCostUnits: number
    }
    expect(body.usage.inputTokens?.state).toBe('unavailable')
    expect(body.usage.inputTokens?.value).toBeNull()
    expect(body.usage.estimatedCostUnits?.state).toBe('estimated')
    expect(body.spentCostUnits).toBe(11.88)
    expect(harness.calls().every((args) => args[1] !== 'outcome')).toBe(true)
  })

  // -- overrides ---------------------------------------------------------

  it('records an override and never forges the approval phrase', async () => {
    harness.fixture(`routing-override-${RUN}`, {
      schemaVersion: 1, runId: RUN, target: 'task:solutioning-1',
      changes: [{ field: 'model', from: 'sonnet', to: 'opus' }],
      decisionHash: 'sha256:new', previousDecisionHash: 'sha256:abc',
      estimatedCostUnits: 40, warnings: [],
    })
    const unconfirmed = await post(`/api/runs/${RUN}/routing/override`, {
      taskId: 'solutioning-1', model: 'opus', effort: 'high', reason: 'needs the stronger model',
    })
    expect(unconfirmed.statusCode).toBe(200)
    let call = harness.calls().find((args) => args[1] === 'override')
    expect(call).not.toContain('--approve')

    const confirmed = await post(`/api/runs/${RUN}/routing/override`, {
      taskId: 'solutioning-1', model: 'opus', effort: 'high', reason: 'needs the stronger model',
      confirmation: `APPROVE ROUTING ${RUN}`,
    })
    expect(confirmed.statusCode).toBe(200)
    call = harness.calls().filter((args) => args[1] === 'override').at(-1)
    expect(call).toContain('--approve')
  })

  it('does not pass --approve for a phrase that does not match', async () => {
    harness.fixture(`routing-override-${RUN}`, {
      schemaVersion: 1, runId: RUN, target: 'task:solutioning-1', changes: [],
    })
    await post(`/api/runs/${RUN}/routing/override`, {
      taskId: 'solutioning-1', model: 'opus', reason: 'why not',
      confirmation: 'APPROVE ROUTING some-other-run',
    })
    const call = harness.calls().find((args) => args[1] === 'override')
    expect(call).not.toContain('--approve')
  })

  it('turns an unconfirmed escalation into an actionable answer', async () => {
    harness.failure(`routing-override-${RUN}`, 8, 'confirmation did not match')
    const response = await post(`/api/runs/${RUN}/routing/override`, {
      taskId: 'solutioning-1', model: 'opus', reason: 'needs the stronger model',
    })
    expect(response.statusCode).toBe(409)
    const body = response.json() as { detail?: string }
    expect(response.body).toContain('routing-confirmation-required')
    expect(body.detail).toBe(`Type exactly: APPROVE ROUTING ${RUN}`)
  })

  it('surfaces a floor refusal as the floor refusal', async () => {
    harness.failure(`routing-override-${RUN}`, 5, JSON.stringify({
      schemaVersion: 1,
      error: {
        code: 'routing-below-floor',
        message: "haiku at 'auto' effort is below this task's 'high' quality floor",
        hint: 'A floor is not negotiable by override.',
      },
    }))
    const response = await post(`/api/runs/${RUN}/routing/override`, {
      taskId: 'solutioning-1', model: 'haiku', effort: 'auto',
      reason: 'cheaper', confirmation: `APPROVE ROUTING ${RUN}`,
    })
    expect(response.statusCode).toBe(409)
    expect(response.body).toContain('routing-below-floor')
  })

  it('needs a reason, a target and something to change', async () => {
    const noReason = await post(`/api/runs/${RUN}/routing/override`, {
      taskId: 'solutioning-1', model: 'opus',
    })
    expect(noReason.statusCode).toBe(400)
    const bothTargets = await post(`/api/runs/${RUN}/routing/override`, {
      taskId: 'solutioning-1', orchestrator: true, model: 'opus', reason: 'x',
    })
    expect(bothTargets.statusCode).toBe(400)
    const nothingToChange = await post(`/api/runs/${RUN}/routing/override`, {
      taskId: 'solutioning-1', reason: 'x',
    })
    expect(nothingToChange.statusCode).toBe(400)
    expect(harness.calls().some((args) => args[1] === 'override')).toBe(false)
  })

  it('keeps its CSRF and token protections', async () => {
    harness.fixture(`routing-override-${RUN}`, {
      schemaVersion: 1, runId: RUN, target: 'task:solutioning-1', changes: [],
    })
    const noToken = await harness.app.inject({
      method: 'POST', url: `/api/runs/${RUN}/routing/override`,
      headers: { origin: 'http://127.0.0.1:7317' },
      payload: { taskId: 'solutioning-1', model: 'opus', reason: 'x' },
    })
    expect(noToken.statusCode).toBe(401)
    const noOrigin = await harness.app.inject({
      method: 'POST', url: `/api/runs/${RUN}/routing/override`,
      headers: authed(harness.token),
      payload: { taskId: 'solutioning-1', model: 'opus', reason: 'x' },
    })
    expect(noOrigin.statusCode).toBe(403)
    const crossSite = await harness.app.inject({
      method: 'POST', url: '/api/routing/preview',
      headers: { ...authed(harness.token), origin: 'http://evil.example' },
      payload: { orchestrator: 'work', requirement: 'Add a paginated orders endpoint.' },
    })
    expect(crossSite.statusCode).toBe(403)
    expect(harness.calls().some((args) => args[1] === 'override')).toBe(false)
  })

  // -- reporting ---------------------------------------------------------

  it('reports calibration as recommendations that changed nothing', async () => {
    harness.fixture('routing-report', {
      schemaVersion: 1,
      generatedAt: '2026-09-07T12:00:00+00:00',
      policyRevision: '2026-09-07.1',
      scope: { runsRead: 9 },
      runs: { total: 9, approved: 8 },
      attempts: { total: 12, retries: 2, escalations: 1 },
      cost: {
        estimatedConsumed: { state: 'estimated', value: 140.2, source: 'policy weights' },
        reportedMonetary: { state: 'unavailable', value: null, reason: 'no provider reported one' },
        costUnitsAreEstimates: true,
      },
      calibration: {
        minSample: 5,
        recommendations: [{
          id: 'lower-recommended-tier-complex',
          observation: '6 of 8 first-attempt passes came from a lower tier',
          recommendation: 'consider lowering bands.complex.recommendedTier',
          sampleSize: 6, confidence: 'medium', appliesTo: 'bands.complex.recommendedTier',
          evidence: ['run-a solutioning-1: passed first time at standard/high'],
          applied: false, note: 'for human review only; this report changes no policy',
        }],
        insufficientEvidence: [],
        policyChanged: false,
        note: 'This controller does not update its own routing policy.',
      },
    })
    const response = await get('/api/routing/report?minSample=5')
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      calibration: {
        policyChanged: boolean
        recommendations: { applied: boolean; note: string }[]
      }
      cost: { reportedMonetary: { state: string; value: unknown } }
    }
    expect(body.calibration.policyChanged).toBe(false)
    expect(body.calibration.recommendations[0]?.applied).toBe(false)
    expect(body.calibration.recommendations[0]?.note).toContain('human review only')
    expect(body.cost.reportedMonetary.state).toBe('unavailable')
    expect(body.cost.reportedMonetary.value).toBeNull()
  })

  it('refuses unusable report filters', async () => {
    const response = await get('/api/routing/report?since=yesterday')
    expect(response.statusCode).toBe(400)
    expect(harness.calls().some((args) => args[1] === 'report')).toBe(false)
  })

  // -- the console writes no routing files -------------------------------

  it('never writes a routing file itself', async () => {
    harness.fixture('routing-preview', { schemaVersion: 1, preview: decision() })
    harness.fixture(`routing-override-${RUN}`, {
      schemaVersion: 1, runId: RUN, target: 'task:solutioning-1', changes: [],
    })
    await post('/api/routing/preview', {
      orchestrator: 'work', requirement: 'Add a paginated orders endpoint to the API.',
    })
    await post(`/api/runs/${RUN}/routing/override`, {
      taskId: 'solutioning-1', model: 'opus', reason: 'x',
      confirmation: `APPROVE ROUTING ${RUN}`,
    })
    const { readdirSync, existsSync } = await import('node:fs')
    const path = await import('node:path')
    const runDir = path.join(harness.runsRoot, RUN)
    expect(existsSync(runDir)).toBe(false)
    expect(readdirSync(harness.runsRoot)).toEqual([])
  })

  it('rejects a shape that is not a named shape', async () => {
    const response = await post('/api/routing/preview', {
      orchestrator: 'work', requirement: 'Add a paginated orders endpoint to the API.',
      shape: '../../etc/passwd',
    })
    expect(response.statusCode).toBe(400)
  })
})
