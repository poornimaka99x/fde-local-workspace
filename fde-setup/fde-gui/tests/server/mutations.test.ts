import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authed, makeHarness, type Harness } from './harness'
import { claudeSession } from './fixtures'

const RUN = '20260901-max-1-aaaa'
const PROJECT = 'returns-modernisation-a1b2'

/** A same-origin change, as the console's own fetch would send it. */
function mutating(token: string): Record<string, string> {
  return {
    ...authed(token),
    origin: 'http://127.0.0.1:7317',
    'content-type': 'application/json',
  }
}

describe('safe mutations', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await makeHarness()
    harness.fixture('project-create', {
      schemaVersion: 1,
      project: {
        schemaVersion: 1,
        projectId: PROJECT,
        name: 'Returns modernisation',
        description: '',
        repoPaths: [],
        createdAt: '2026-09-03T10:00:00+00:00',
        updatedAt: '2026-09-03T10:00:00+00:00',
      },
    })
    harness.fixture(`project-update-${PROJECT}`, {
      schemaVersion: 1,
      project: {
        schemaVersion: 1,
        projectId: PROJECT,
        name: 'Returns',
        description: 'narrowed',
        repoPaths: [],
        createdAt: '2026-09-03T10:00:00+00:00',
        updatedAt: '2026-09-03T11:00:00+00:00',
      },
    })
    harness.fixture(`project-delete-${PROJECT}`, {
      schemaVersion: 1,
      deletedProject: {
        projectId: PROJECT,
        name: 'Returns modernisation',
        deletedAt: '2026-09-07T10:00:00+00:00',
        recoverable: true,
        runCount: 0,
        chatCount: 0,
      },
    })
    harness.fixture('start', {
      schemaVersion: 1,
      run: {
        runId: RUN,
        state: 'awaiting_plan',
        projectId: PROJECT,
        requirement: 'MAX-1 returns research',
        updatedAt: '2026-09-03T10:00:00+00:00',
        orchestrator: { agentId: 'claude_work', label: 'Claude: work', kind: 'claude' },
        session: claudeSession,
      },
      nextAction: 'fde plan … --stages <stages>',
    })
    harness.fixture(`attach-${RUN}`, {
      schemaVersion: 1,
      attachment: {
        schemaVersion: 1,
        attachmentId: 'abc123',
        runId: RUN,
        originalName: 'requirements.pdf',
        storedName: 'requirements-ab12.pdf',
        relativePath: 'inputs/files/requirements-ab12.pdf',
        mediaType: 'application/pdf',
        size: 11,
        sha256: 'f'.repeat(64),
        attachedAt: '2026-09-03T10:00:00+00:00',
        source: 'stdin',
      },
    })
  })
  afterEach(async () => harness.destroy())

  const post = async (url: string, payload: unknown, headers?: Record<string, string>) =>
    harness.app.inject({
      method: 'POST',
      url,
      headers: headers ?? mutating(harness.token),
      payload: payload as object,
    })

  const upload = async (url: string, body: Buffer, headers?: Record<string, string>) =>
    harness.app.inject({
      method: 'POST',
      url,
      headers: headers ?? {
        ...authed(harness.token),
        origin: 'http://127.0.0.1:7317',
        'content-type': 'application/octet-stream',
      },
      payload: body,
    })

  // -- who may change anything ----------------------------------------------

  it('refuses a change with no token, and one from another origin', async () => {
    const noToken = await post('/api/projects', { name: 'X' }, { 'content-type': 'application/json' })
    expect(noToken.statusCode).toBe(401)

    const foreign = await post('/api/projects', { name: 'X' }, {
      ...authed(harness.token),
      origin: 'http://evil.example',
      'content-type': 'application/json',
    })
    expect(foreign.statusCode).toBe(403)
    expect(harness.calls()).toHaveLength(0)
  })

  it('refuses a change that states no origin at all', async () => {
    const response = await post('/api/projects', { name: 'X' }, {
      ...authed(harness.token),
      'content-type': 'application/json',
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ type: 'about:fde/forbidden-origin' })
    expect(harness.calls()).toHaveLength(0)
  })

  // -- projects --------------------------------------------------------------

  it('creates a project through the controller', async () => {
    const before = (await harness.app.inject({
      method: 'GET', url: '/api/state-version', headers: authed(harness.token),
    })).json().version

    const response = await post('/api/projects', {
      name: '  Returns modernisation  ',
      description: 'Store and web returns',
      repoPaths: ['/tmp'],
    })
    expect(response.statusCode).toBe(201)
    expect(response.json().project.projectId).toBe(PROJECT)
    expect(harness.calls()[0]).toEqual([
      'project', 'create',
      '--name', 'Returns modernisation',
      '--description', 'Store and web returns',
      '--repo', '/tmp',
      '--json',
    ])

    const after = (await harness.app.inject({
      method: 'GET', url: '/api/state-version', headers: authed(harness.token),
    })).json().version
    expect(after).toBeGreaterThan(before)
  })

  it('refuses a project the controller should never be asked to create', async () => {
    const cases: unknown[] = [
      { name: '   ' },
      { name: 'ok', description: 'a\u0000b' },
      { name: 'a\u001bmalicious' },
      { name: 'ok', repoPaths: Array.from({ length: 21 }, () => '/tmp') },
      { name: 'x'.repeat(201) },
      {},
    ]
    for (const payload of cases) {
      const response = await post('/api/projects', payload)
      expect(response.statusCode, JSON.stringify(payload)).toBe(400)
    }
    expect(harness.calls()).toHaveLength(0)
  })

  it('passes a controller refusal back in the controller\u2019s own words', async () => {
    harness.failure('project-create', 2, 'fde: repository path does not exist: /nope')
    const response = await post('/api/projects', { name: 'X', repoPaths: ['/nope'] })
    expect(response.statusCode).toBe(400)
    expect(response.json().detail).toContain('repository path does not exist')
  })

  it('updates a project, and refuses an update that changes nothing', async () => {
    const ok = await harness.app.inject({
      method: 'PATCH',
      url: `/api/projects/${PROJECT}`,
      headers: mutating(harness.token),
      payload: { name: 'Returns', description: 'narrowed' },
    })
    expect(ok.statusCode).toBe(200)
    expect(harness.calls()[0]).toEqual([
      'project', 'update', PROJECT, '--name', 'Returns', '--description', 'narrowed', '--json',
    ])

    const empty = await harness.app.inject({
      method: 'PATCH',
      url: `/api/projects/${PROJECT}`,
      headers: mutating(harness.token),
      payload: {},
    })
    expect(empty.statusCode).toBe(400)

    const bad = await harness.app.inject({
      method: 'PATCH',
      url: '/api/projects/..%2Fsecrets',
      headers: mutating(harness.token),
      payload: { name: 'x' },
    })
    expect(bad.statusCode).toBeGreaterThanOrEqual(400)
    expect(harness.calls()).toHaveLength(1)
  })

  it('deletes a project through the controller with exact confirmation', async () => {
    const response = await harness.app.inject({
      method: 'DELETE',
      url: `/api/projects/${PROJECT}`,
      headers: mutating(harness.token),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().deletedProject).toMatchObject({ projectId: PROJECT, recoverable: true })
    expect(harness.calls()[0]).toEqual([
      'project', 'delete', PROJECT, '--confirm', PROJECT, '--json',
    ])
  })

  // -- runs ------------------------------------------------------------------

  it('creates a run with only what the new-run flow may collect', async () => {
    const response = await post('/api/runs', {
      projectId: PROJECT,
      requirement: 'MAX-1 returns research',
      orchestrator: 'work',
      shape: 'research',
    })
    expect(response.statusCode).toBe(201)
    expect(response.json().run.runId).toBe(RUN)
    expect(harness.calls()[0]).toEqual([
      'start', '--json', '--orchestrator', 'work',
      '--model', 'default', '--effort', 'auto',
      '--project', PROJECT, '--shape', 'research',
      '--', 'MAX-1 returns research',
    ])
  })

  it('treats a requirement that starts with a dash as text, not a flag', async () => {
    const response = await post('/api/runs', {
      requirement: '--dangerously-do-something',
      orchestrator: 'work',
    })
    expect(response.statusCode).toBe(201)
    const call = harness.calls()[0] ?? []
    expect(call[call.length - 2]).toBe('--')
    expect(call[call.length - 1]).toBe('--dangerously-do-something')
  })

  it('never asks the controller for a role, an approval or an unknown orchestrator', async () => {
    for (const payload of [
      { orchestrator: 'gemini' },
      { orchestrator: 'work', projectId: '../secrets' },
      { orchestrator: 'work', shape: 'research; rm -rf /' },
      { orchestrator: 'work', requirement: 'x'.repeat(4001) },
      { requirement: 'no orchestrator' },
    ]) {
      const response = await post('/api/runs', payload)
      expect(response.statusCode, JSON.stringify(payload)).toBe(400)
    }
    expect(harness.calls()).toHaveLength(0)
  })

  // -- attachments -----------------------------------------------------------

  it('sends an upload to the controller\u2019s stdin, never to a path', async () => {
    const response = await upload(
      `/api/runs/${RUN}/attachments?name=${encodeURIComponent('../../etc/passwd')}`,
      Buffer.from('file bytes'),
    )
    expect(response.statusCode).toBe(201)
    expect(response.json().attachment.attachmentId).toBe('abc123')

    const call = harness.calls()[0] ?? []
    expect(call.slice(0, 5)).toEqual(['attach', RUN, '--stdin', '--name', '../../etc/passwd'])
    expect(call).toContain('--max-bytes')
    expect(harness.stdinFor(`attach-${RUN}`)?.toString()).toBe('file bytes')
  })

  it('needs the original filename, and refuses a control character in it', async () => {
    expect((await upload(`/api/runs/${RUN}/attachments`, Buffer.from('x'))).statusCode).toBe(400)
    expect(
      (await upload(`/api/runs/${RUN}/attachments?name=a%00b`, Buffer.from('x'))).statusCode,
    ).toBe(400)
    expect(harness.calls()).toHaveLength(0)
  })

  it('refuses an upload larger than the console accepts', async () => {
    const small = await makeHarness({ maxUploadBytes: 1024 })
    try {
      small.fixture(`attach-${RUN}`, { schemaVersion: 1, attachment: {} })
      const response = await small.app.inject({
        method: 'POST',
        url: `/api/runs/${RUN}/attachments?name=big.bin`,
        headers: {
          ...authed(small.token),
          origin: 'http://127.0.0.1:7317',
          'content-type': 'application/octet-stream',
        },
        payload: Buffer.alloc(2048),
      })
      expect(response.statusCode).toBe(413)
      expect(small.stdinFor(`attach-${RUN}`)).toBeNull()
    } finally {
      await small.destroy()
    }
  }, 20000)

  // -- concurrency -----------------------------------------------------------

  it('tells the operator a run is busy instead of racing another change', async () => {
    const release = harness.locks.tryAcquire(`run:${RUN}`)
    expect(release).not.toBeNull()
    const response = await upload(
      `/api/runs/${RUN}/attachments?name=a.txt`,
      Buffer.from('x'),
    )
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ type: 'about:fde/busy' })
    expect(harness.calls()).toHaveLength(0)
    release?.()
  })

  it('releases the lock once a change finishes, including a failed one', async () => {
    harness.failure('project-create', 2, 'fde: nope')
    expect((await post('/api/projects', { name: 'X' })).statusCode).toBe(400)
    expect(harness.locks.isHeld('project:create')).toBe(false)
  })

  it('reports whether it is watching the filesystem', async () => {
    const response = await harness.app.inject({
      method: 'GET', url: '/api/state-version', headers: authed(harness.token),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ version: expect.any(Number) })
    expect(typeof response.json().watching).toBe('boolean')
  })
})
