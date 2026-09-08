import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authed, makeHarness, type Harness } from './harness'
import { runRows, statusFixture } from './fixtures'

const RUN = '20260901-max-1-aaaa'

describe('controller boundary', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await makeHarness()
    harness.fixture('list', {
      schemaVersion: 1,
      runs: runRows,
      warnings: ['runs/broken/manifest.json: malformed manifest.json'],
    })
    harness.fixture(`status-${RUN}`, statusFixture(RUN))
  })
  afterEach(async () => harness.destroy())

  const get = async (url: string) =>
    harness.app.inject({ method: 'GET', url, headers: authed(harness.token) })

  it('lists runs newest first and passes controller warnings through', async () => {
    const response = await get('/api/runs')
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.runs.map((run: { runId: string }) => run.runId)).toEqual([
      '20260902-max-2-bbbb',
      RUN,
    ])
    expect(body.warnings).toHaveLength(1)
  })

  it('filters by project, state, resumability and free text', async () => {
    expect((await get('/api/runs?projectId=unassigned')).json().runs).toHaveLength(1)
    expect((await get('/api/runs?projectId=returns-a1b2')).json().runs).toHaveLength(1)
    expect((await get('/api/runs?state=complete')).json().runs).toHaveLength(1)
    expect((await get('/api/runs?resumable=false')).json().runs[0].runId).toBe('20260902-max-2-bbbb')
    expect((await get('/api/runs?query=MAX-1')).json().runs).toHaveLength(1)
    expect((await get('/api/runs?query=nothing-matches')).json().runs).toHaveLength(0)
  })

  it('maps an unknown run to 404', async () => {
    const response = await get('/api/runs/20260101-missing-zzzz')
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ type: 'about:fde/not-found' })
  })

  it('shows a controller gate refusal as a refusal, in its own words', async () => {
    harness.failure(`status-${RUN}`, 7, 'fde: run cannot publish: nothing has been approved')
    const response = await get(`/api/runs/${RUN}`)
    expect(response.statusCode).toBe(409)
    expect(response.json().detail).toContain('nothing has been approved')
  })

  it('maps rejected input to 400', async () => {
    harness.failure(`status-${RUN}`, 2, 'fde: unknown stage')
    expect((await get(`/api/runs/${RUN}`)).statusCode).toBe(400)
  })

  it('never spawns the controller for an identifier it does not like', async () => {
    for (const runId of ['../../etc/passwd', 'run;rm -rf /', 'run id', '$(whoami)', 'run\nid']) {
      const response = await get(`/api/runs/${encodeURIComponent(runId)}`)
      expect(response.statusCode, runId).toBeGreaterThanOrEqual(400)
      expect(response.statusCode, runId).toBeLessThan(500)
    }
    for (const projectId of ['../secrets', 'Project;ls', 'x'.repeat(200)]) {
      const response = await get(`/api/projects/${encodeURIComponent(projectId)}`)
      expect(response.statusCode, projectId).toBeGreaterThanOrEqual(400)
      expect(response.statusCode, projectId).toBeLessThan(500)
    }
    expect(harness.calls()).toHaveLength(0)
  })

  it('forwards event paging to the controller', async () => {
    const response = await get(`/api/runs/${RUN}/events?cursor=10&limit=25`)
    expect(response.statusCode).toBe(200)
    expect(response.json().events).toMatchObject({
      offset: 10,
      limit: 25,
      returned: 25,
      nextCursor: 35,
    })
    const call = harness.calls().at(-1)
    expect(call).toContain('--events-cursor')
    expect(call).toContain('10')
  })

  it('rejects unusable paging values before calling anything', async () => {
    expect((await get(`/api/runs/${RUN}/events?limit=99999`)).statusCode).toBe(400)
    expect((await get(`/api/runs/${RUN}/events?cursor=-4`)).statusCode).toBe(400)
  })

  it('turns non-JSON controller output into a 502, not a crash', async () => {
    harness.rawFixture(`status-${RUN}`, 'not json at all')
    const response = await get(`/api/runs/${RUN}`)
    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ type: 'about:fde/controller-unreadable' })
  })

  it('reports an unexpected controller shape instead of rendering it', async () => {
    harness.rawFixture(`status-${RUN}`, JSON.stringify({ schemaVersion: 1 }))
    const response = await get(`/api/runs/${RUN}`)
    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ type: 'about:fde/controller-unexpected-shape' })
  })

  it('names an outdated controller instead of pasting its usage string', async () => {
    // What a pre-contract fde actually says when the console calls it.
    harness.failure(
      'list',
      2,
      "usage: fde [-h] {doctor,start,orchestrator,request,plan,shapes,list,roles}\n" +
        'fde: error: unrecognized arguments: --json',
    )
    const response = await get('/api/runs')
    expect(response.statusCode).toBe(503)
    const body = response.json()
    expect(body).toMatchObject({ type: 'about:fde/controller-outdated' })
    expect(body.title).toContain('older than this console')
    expect(body.detail).toContain('./install.sh')
    expect(body.detail).not.toContain('usage: fde')
  })

  it('names an outdated controller for a missing subcommand too', async () => {
    harness.failure(
      'projects',
      2,
      "fde: error: argument cmd: invalid choice: 'projects' (choose from 'doctor', 'start')",
    )
    const response = await get('/api/projects')
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ type: 'about:fde/controller-outdated' })
  })

  it('still reports a real refusal as a refusal', async () => {
    harness.failure(`status-${RUN}`, 2, 'fde: unknown stage')
    const response = await get(`/api/runs/${RUN}`)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ type: 'about:fde/controller-rejected-input' })
  })

  it('reports the contract check in health', async () => {
    harness.fixture('version', {
      schemaVersion: 1,
      toolkit: 'fde-core',
      contracts: ['list --json', 'status --json'],
    })
    const healthy = await get('/api/health')
    expect(healthy.json().controller).toMatchObject({ ok: true, schemaVersion: 1 })

    const stale = await makeHarness()
    try {
      stale.failure('version', 2, "fde: error: argument cmd: invalid choice: 'version'")
      const response = await stale.app.inject({
        method: 'GET', url: '/api/health', headers: authed(stale.token),
      })
      expect(response.json().controller).toMatchObject({
        ok: false,
        problem: 'controller-outdated',
      })
      expect(response.json().controller.detail).toContain('./install.sh')
    } finally {
      await stale.destroy()
    }
  })

  it('says so when the controller is not installed', async () => {
    const bare = await makeHarness({ withController: false })
    try {
      const response = await bare.app.inject({
        method: 'GET',
        url: '/api/runs',
        headers: authed(bare.token),
      })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toMatchObject({ type: 'about:fde/controller-unavailable' })
    } finally {
      await bare.destroy()
    }
  })

  it('never forwards an undocumented failure, traceback and all', async () => {
    harness.failure(
      `status-${RUN}`,
      1,
      'Traceback (most recent call last):\n  File "/x/fde", line 9, in <module>\n    AttributeError',
    )
    const response = await get(`/api/runs/${RUN}`)
    expect(response.statusCode).toBe(502)
    expect(response.payload).not.toContain('Traceback')
    expect(response.payload).not.toContain('AttributeError')
    expect(response.json().detail).toBeUndefined()
  })

  it('still forwards a documented refusal, because that is the evidence', async () => {
    harness.failure(`status-${RUN}`, 6, 'fde: roles are not confirmed, so reading Jira is not permitted')
    const response = await get(`/api/runs/${RUN}`)
    expect(response.statusCode).toBe(409)
    expect(response.json().detail).toContain('roles are not confirmed')
  })

  it('refuses a schema version it was not written for', async () => {
    harness.rawFixture(`status-${RUN}`, JSON.stringify({ ...statusFixture(RUN), schemaVersion: 2 }))
    const response = await get(`/api/runs/${RUN}`)
    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ type: 'about:fde/controller-unexpected-shape' })
  })

  it('refuses a payload the UI would crash on, before the UI sees it', async () => {
    for (const broken of [
      { roles: 'not an object' },
      { roles: { confirmed: true, assignments: 'nope' } },
      { artifacts: { expected: 'nope', discovered: [] } },
      { requirement: null },
      { events: { total: 'many' } },
    ]) {
      harness.rawFixture(`status-${RUN}`, JSON.stringify({ ...statusFixture(RUN), ...broken }))
      const response = await get(`/api/runs/${RUN}`)
      expect(response.statusCode, JSON.stringify(broken)).toBe(502)
      expect(response.json()).toMatchObject({ type: 'about:fde/controller-unexpected-shape' })
    }
  })

  it('tolerates thin records inside a well-shaped payload', async () => {
    harness.rawFixture(
      `status-${RUN}`,
      JSON.stringify({
        ...statusFixture(RUN),
        attachments: [{ attachmentId: 'only-an-id' }],
        approvals: [{ approvalId: 'a1' }],
        artifacts: { expected: [{ path: 'research/brief.md' }] },
        roles: { assignments: [{ role: 'research' }] },
      }),
    )
    const response = await get(`/api/runs/${RUN}`)
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.attachments[0]).toMatchObject({ originalName: '(unnamed)', size: 0 })
    expect(body.approvals[0]).toMatchObject({ status: 'malformed' })
    expect(body.artifacts.expected[0]).toMatchObject({ found: false })
    expect(body.artifacts.discovered).toEqual([])
    expect(body.roles.assignments[0]).toMatchObject({ role: 'research', assignees: [] })
  })

  it('hands the controller only the environment the toolkit needs', async () => {
    const { controllerEnv } = await import('../../server/src/services/controller')
    const passed = controllerEnv(harness.config)
    expect(Object.keys(passed).sort()).toEqual([
      'CLAUDE_PROFILES_DIR',
      'CLAUDE_SHARED',
      'FDE_CHATS_DIR',
      'FDE_CODEX_PROFILES_DIR',
      'FDE_COPILOT_PROFILES_DIR',
      'FDE_PROJECTS_DIR',
      'FDE_RUNS_DIR',
      'HOME',
      'LANG',
      'PATH',
      'USER',
    ])
    expect(JSON.stringify(passed)).not.toContain(harness.token)
  })
})
