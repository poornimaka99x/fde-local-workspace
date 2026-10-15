import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authed, makeHarness, type Harness } from './harness'
import { statusFixture } from './fixtures'

const OLD = '20260902-old-complete-bbbb'
const ACTIVE = '20260903-still-working-cccc'
const CHANGED = '20260904-changed-state-dddd'

describe('completed-run retention', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await makeHarness()
  })
  afterEach(async () => harness.destroy())

  const mutationHeaders = (token: string): Record<string, string> => ({
    ...authed(token),
    origin: 'http://127.0.0.1:7317',
  })

  it('defaults to enabled with five days and persists an operator change', async () => {
    const initial = await harness.app.inject({
      method: 'GET', url: '/api/configuration/retention', headers: authed(harness.token),
    })
    expect(initial.json().settings).toEqual({
      schemaVersion: 1, enabled: true, completedRunDays: 5,
    })

    const saved = await harness.app.inject({
      method: 'PUT', url: '/api/configuration/retention', headers: mutationHeaders(harness.token),
      payload: { enabled: false, completedRunDays: 30 },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().settings).toMatchObject({ enabled: false, completedRunDays: 30 })
  })

  it('moves only old controller-confirmed complete runs through recoverable deletion', async () => {
    harness.fixture('list', {
      schemaVersion: 1,
      warnings: [],
      runs: [
        { runId: OLD, state: 'complete', projectId: null,
          updatedAt: '2026-09-01T00:00:00Z', session: { resumable: false } },
        { runId: ACTIVE, state: 'implementation', projectId: null,
          updatedAt: '2026-09-01T00:00:00Z', session: { resumable: false } },
        { runId: CHANGED, state: 'complete', projectId: null,
          updatedAt: '2026-09-01T00:00:00Z', session: { resumable: false } },
      ],
    })
    harness.fixture(`status-${OLD}`, {
      ...statusFixture(OLD),
      state: 'complete',
      manifest: { runId: OLD, state: 'complete', updatedAt: '2026-09-01T00:00:00Z' },
    })
    harness.fixture(`delete-${OLD}`, {
      schemaVersion: 1,
      deletedRun: {
        runId: OLD, projectId: null, state: 'complete',
        deletedAt: '2026-10-15T00:00:00Z', recoverable: true,
      },
    })
    harness.fixture(`status-${CHANGED}`, {
      ...statusFixture(CHANGED),
      state: 'implementation',
      manifest: { runId: CHANGED, state: 'implementation', updatedAt: '2026-09-01T00:00:00Z' },
    })

    const response = await harness.app.inject({
      method: 'PUT', url: '/api/configuration/retention', headers: mutationHeaders(harness.token),
      payload: { enabled: true, completedRunDays: 5 },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().sweep.deletedRunIds).toEqual([OLD])
    expect(harness.calls()).toContainEqual(['delete', OLD, '--confirm', OLD, '--json'])
    expect(harness.calls().some((call) => call.includes(ACTIVE))).toBe(false)
    expect(response.json().sweep.skippedRunIds).toContain(CHANGED)
    expect(harness.calls()).not.toContainEqual(['delete', CHANGED, '--confirm', CHANGED, '--json'])
  })

  it('rejects unsafe retention periods without changing settings', async () => {
    const response = await harness.app.inject({
      method: 'PUT', url: '/api/configuration/retention', headers: mutationHeaders(harness.token),
      payload: { enabled: true, completedRunDays: 0 },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ type: 'about:fde/invalid-retention' })
  })
})
