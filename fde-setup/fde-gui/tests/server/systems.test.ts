import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authed, makeHarness, type Harness } from './harness'
import { claudeSession } from './fixtures'

const RUN = '20260911-fde-aaaa'

describe('Forward Deployed Engineer system', () => {
  let harness: Harness
  const mutationHeaders = (): Record<string, string> => ({
    ...authed(harness.token),
    origin: 'http://127.0.0.1:7317',
    'content-type': 'application/json',
  })

  beforeEach(async () => {
    harness = await makeHarness()
    harness.fixture('list', { schemaVersion: 1, runs: [], warnings: [] })
    harness.fixture('start', {
      schemaVersion: 1,
      run: {
        runId: RUN, state: 'awaiting_roles', projectId: null,
        requirement: 'Improve checkout conversion', updatedAt: '2026-09-11T10:00:00Z',
        orchestrator: { agentId: 'claude_work', label: 'Claude: work', kind: 'claude' },
        session: claudeSession,
      },
      nextAction: `fde roles ${RUN}`,
    })
  })

  afterEach(async () => harness.destroy())

  it('registers the system and exposes a safe default configuration', async () => {
    const systems = await harness.app.inject({ method: 'GET', url: '/api/system-types', headers: authed(harness.token) })
    expect(systems.statusCode).toBe(200)
    expect(systems.json().systemTypes[0]).toMatchObject({
      id: 'forward-deployed-engineer', executorType: 'forward-deployed-engineer',
    })

    const configurations = await harness.app.inject({ method: 'GET', url: '/api/system-configurations', headers: authed(harness.token) })
    expect(configurations.json().configurations[0]).toMatchObject({
      id: 'default-forward-deployed-engineer',
      systemType: 'forward-deployed-engineer',
      executorType: 'forward-deployed-engineer',
    })
    expect(configurations.json().configurations[0].stages).toHaveLength(9)
    expect(configurations.json().configurations[0].governance).toEqual({
      approvalAfterEveryStage: true,
      approvalBeforeCodeChanges: true,
      approvalBeforeDeployment: true,
      approvalBeforeProductionMutation: true,
      stopOnAmbiguity: true,
    })
  })

  it('creates and updates named profiles without changing the built-in default', async () => {
    const created = await harness.app.inject({
      method: 'POST', url: '/api/system-configurations', headers: mutationHeaders(),
      payload: { name: 'Azure Enterprise FDE' },
    })
    expect(created.statusCode).toBe(201)
    const record = created.json().configuration
    expect(record.name).toBe('Azure Enterprise FDE')

    record.description = 'Azure delivery profile'
    record.stages[8].enabled = false
    const saved = await harness.app.inject({
      method: 'PUT', url: `/api/system-configurations/${record.id}`, headers: mutationHeaders(), payload: record,
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().configuration.version).toBeGreaterThan(record.version)
    expect(saved.json().configuration.stages[8].enabled).toBe(false)

    const defaultRecord = await harness.app.inject({
      method: 'GET', url: '/api/system-configurations/default-forward-deployed-engineer', headers: authed(harness.token),
    })
    expect(defaultRecord.json().configuration.stages.every((stage: { enabled: boolean }) => stage.enabled)).toBe(true)
  })

  it('starts and separately registers a full lifecycle run through the FDE executor', async () => {
    const response = await harness.app.inject({
      method: 'POST', url: '/api/fde-runs', headers: mutationHeaders(),
      payload: {
        configurationId: 'default-forward-deployed-engineer',
        orchestrator: 'work',
        businessIntent: 'Improve checkout conversion while preserving accessibility.',
      },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      run: { runId: RUN },
      registration: {
        runId: RUN,
        systemType: 'forward-deployed-engineer',
        executorType: 'forward-deployed-engineer',
        configurationId: 'default-forward-deployed-engineer',
      },
    })
    expect(harness.calls()).toContainEqual(expect.arrayContaining([
      'start', '--json', '--orchestrator', 'claude_work', '--shape', 'full',
    ]))

    harness.fixture('list', { schemaVersion: 1, runs: [response.json().run], warnings: [] })
    const history = await harness.app.inject({ method: 'GET', url: '/api/fde-runs', headers: authed(harness.token) })
    expect(history.json().total).toBe(1)
    expect(history.json().runs[0].registration.runId).toBe(RUN)
  }, 15_000)
})
