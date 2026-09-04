import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { authed, makeHarness, seedRunDirectory, type Harness } from './harness'
import { statusFixture, codexSession } from './fixtures'
import { FakeTerminal, fakeSpawn } from './fake-terminal'

const RUN = '20260901-max-1-aaaa'
const CODEX_RUN = '20260902-max-2-bbbb'

function mutating(token: string): Record<string, string> {
  return { ...authed(token), origin: 'http://127.0.0.1:7317', 'content-type': 'application/json' }
}

async function collect(socket: WebSocket, until: (message: Record<string, unknown>) => boolean, timeoutMs = 3000): Promise<Record<string, unknown>[]> {
  const seen: Record<string, unknown>[] = []
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out; saw ${JSON.stringify(seen)}`)), timeoutMs)
    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
      seen.push(message)
      if (until(message)) {
        clearTimeout(timer)
        resolve(seen)
      }
    })
    socket.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

describe('resume sessions', () => {
  let harness: Harness

  beforeEach(async () => {
    FakeTerminal.spawned = []
    harness = await makeHarness({ spawnTerminal: fakeSpawn })
    seedRunDirectory(harness.runsRoot, RUN)
    seedRunDirectory(harness.runsRoot, CODEX_RUN)
    harness.fixture(`status-${RUN}`, {
      ...statusFixture(RUN),
      project: { projectId: 'returns-a1b2', name: 'Returns', repoPaths: [harness.root] },
    })
    harness.fixture(`status-${CODEX_RUN}`, {
      ...statusFixture(CODEX_RUN),
      session: codexSession,
    })
  })
  afterEach(async () => harness.destroy())

  const resume = async (runId: string) =>
    harness.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/session/resume`,
      headers: mutating(harness.token),
    })

  it('starts exactly fde-start --resume for the run, and nothing else', async () => {
    const response = await resume(RUN)
    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.status).toBe('started')
    expect(typeof body.ticket).toBe('string')

    expect(FakeTerminal.spawned).toHaveLength(1)
    const spawned = FakeTerminal.spawned[0]
    expect(spawned?.options.file).toBe(harness.config.fdeStartBin)
    expect(spawned?.options.args).toEqual(['--resume', RUN])
    // The project's first repository, as the brief requires.
    expect(spawned?.options.cwd).toBe(harness.root)
    expect(body.session.command).toEqual([harness.config.fdeStartBin, '--resume', RUN])
  })

  it('hands the session only the environment an FDE profile needs', async () => {
    await resume(RUN)
    const env = FakeTerminal.spawned[0]?.options.env ?? {}
    expect(Object.keys(env).sort()).toEqual([
      'CLAUDE_PROFILES_DIR', 'CLAUDE_SHARED', 'COLORTERM', 'FDE_PROJECTS_DIR',
      'FDE_RUNS_DIR', 'HOME', 'LANG', 'PATH', 'TERM',
    ])
    expect(JSON.stringify(env)).not.toContain(harness.token)
    const listed = (await harness.app.inject({
      method: 'GET', url: `/api/runs/${RUN}/session`, headers: authed(harness.token),
    })).json()
    expect(listed.session.envKeys).not.toContain('AWS_SECRET_ACCESS_KEY')
    expect(JSON.stringify(listed)).not.toContain(harness.token)
  })

  it('never starts a second process for the same run', async () => {
    const first = await resume(RUN)
    const second = await resume(RUN)
    expect(second.statusCode).toBe(200)
    expect(second.json().status).toBe('existing')
    expect(second.json().session.pid).toBe(first.json().session.pid)
    expect(second.json().ticket).not.toBe(first.json().ticket)
    expect(FakeTerminal.spawned).toHaveLength(1)
  })

  it('refuses a Codex-led run in the controller\u2019s own words', async () => {
    const response = await resume(CODEX_RUN)
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ type: 'about:fde/session-not-resumable' })
    expect(response.json().detail).toBe('Resume this run in its original Codex task')
    expect(FakeTerminal.spawned).toHaveLength(0)
  })

  it('refuses a run that does not exist, or is a symlink', async () => {
    expect((await resume('20260101-missing-zzzz')).statusCode).toBe(404)
    const { symlinkSync, mkdirSync } = await import('node:fs')
    const elsewhere = `${harness.root}/planted`
    mkdirSync(elsewhere, { recursive: true })
    symlinkSync(elsewhere, `${harness.runsRoot}/20260101-planted-0000`)
    expect((await resume('20260101-planted-0000')).statusCode).toBe(403)
    expect(FakeTerminal.spawned).toHaveLength(0)
  })

  it('says so honestly when this installation has no terminal backend', async () => {
    const bare = await makeHarness({ spawnTerminal: null })
    try {
      seedRunDirectory(bare.runsRoot, RUN)
      bare.fixture(`status-${RUN}`, statusFixture(RUN))
      const response = await bare.app.inject({
        method: 'POST',
        url: `/api/runs/${RUN}/session/resume`,
        headers: mutating(bare.token),
      })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toMatchObject({ type: 'about:fde/terminal-unavailable' })
      expect(response.json().detail).toContain(`fde-start --resume ${RUN}`)
    } finally {
      await bare.destroy()
    }
  })

  it('stops with an interrupt, and force-stops only when asked', async () => {
    await resume(RUN)
    const terminal = FakeTerminal.spawned[0]

    const stopped = await harness.app.inject({
      method: 'POST', url: `/api/runs/${RUN}/session/stop`, headers: mutating(harness.token),
      payload: {},
    })
    expect(stopped.statusCode).toBe(200)
    expect(terminal?.signals).toEqual(['SIGINT'])
    expect(stopped.json().stopRequestedAt).not.toBeNull()

    await harness.app.inject({
      method: 'POST', url: `/api/runs/${RUN}/session/stop`, headers: mutating(harness.token),
      payload: { force: true },
    })
    expect(terminal?.signals).toEqual(['SIGINT', 'SIGKILL'])

    const missing = await harness.app.inject({
      method: 'POST', url: '/api/runs/20260101-none-0000/session/stop',
      headers: mutating(harness.token), payload: {},
    })
    expect(missing.statusCode).toBe(404)
  })

  it('keeps the final screen and the exit code after the process ends', async () => {
    await resume(RUN)
    const terminal = FakeTerminal.spawned[0]
    terminal?.emit('scoping the run\r\n')
    terminal?.finish(0)

    const session = (await harness.app.inject({
      method: 'GET', url: `/api/runs/${RUN}/session`, headers: authed(harness.token),
    })).json().session
    expect(session.status).toBe('exited')
    expect(session.exitCode).toBe(0)

    const listed = (await harness.app.inject({
      method: 'GET', url: '/api/sessions', headers: authed(harness.token),
    })).json()
    expect(listed.available).toBe(true)
    expect(listed.sessions).toHaveLength(1)
  })

  it('hangs up running sessions when the server closes', async () => {
    await resume(RUN)
    const terminal = FakeTerminal.spawned[0]
    await harness.app.close()
    expect(terminal?.signals).toEqual(['SIGHUP'])
  })
})

describe('the terminal stream', () => {
  let harness: Harness
  let base: string

  beforeEach(async () => {
    FakeTerminal.spawned = []
    harness = await makeHarness({ spawnTerminal: fakeSpawn })
    seedRunDirectory(harness.runsRoot, RUN)
    harness.fixture(`status-${RUN}`, statusFixture(RUN))
    base = await harness.listen()
  })
  afterEach(async () => harness.destroy())

  const startSession = async (): Promise<string> => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/runs/${RUN}/session/resume`,
      headers: mutating(harness.token),
    })
    return response.json().ticket as string
  }

  const startSessionTicket = async (): Promise<string> => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/runs/${RUN}/session/resume`,
      headers: mutating(harness.token),
    })
    return response.json().ticket as string
  }

  const open = (ticket: string, runId = RUN): WebSocket =>
    new WebSocket(`ws://${base}/api/runs/${runId}/session/terminal?ticket=${encodeURIComponent(ticket)}`, {
      origin: 'http://127.0.0.1:7317',
    })

  it('replays what is on screen, then streams, and forwards typing and resize', async () => {
    const ticket = await startSession()
    const terminal = FakeTerminal.spawned[0]
    terminal?.emit('before you attached\r\n')

    const socket = open(ticket)
    const ready = await collect(socket, (message) => message.type === 'ready')
    expect(ready[0]).toMatchObject({ type: 'ready' })
    expect(String((ready[0] as { backlog: string }).backlog)).toContain('before you attached')

    const streaming = collect(socket, (message) => message.type === 'output')
    terminal?.emit('live output')
    expect(String(((await streaming).at(-1) as { data: string }).data)).toBe('live output')

    socket.send(JSON.stringify({ type: 'input', data: 'APPROVE PLAN\r' }))
    socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40 }))
    socket.send('not json at all')
    socket.send(JSON.stringify({ type: 'exec', data: 'rm -rf /' }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(terminal?.written).toEqual(['APPROVE PLAN\r'])
    expect(terminal?.resizes).toEqual([{ cols: 100, rows: 40 }])

    const exiting = collect(socket, (message) => message.type === 'exit')
    terminal?.finish(3)
    expect((await exiting).at(-1)).toMatchObject({ type: 'exit', exitCode: 3 })
    socket.close()
  })

  it('closing the tab detaches a viewer and leaves the process alone', async () => {
    const ticket = await startSession()
    const socket = open(ticket)
    await collect(socket, (message) => message.type === 'ready')
    socket.close()
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(FakeTerminal.spawned[0]?.signals).toEqual([])
    const session = (await harness.app.inject({
      method: 'GET', url: `/api/runs/${RUN}/session`, headers: authed(harness.token),
    })).json().session
    expect(session.status).toBe('running')
    expect(session.attachedClients).toBe(0)
  })

  it('refuses a ticket that is missing, wrong, reused or for another run', async () => {
    const ticket = await startSession()

    // The ticket works once.
    const first = open(ticket)
    await collect(first, (message) => message.type === 'ready')
    first.close()

    // And never again — nor does a guess, an empty one, or one for another run.
    const outcomes: string[] = []
    for (const attempt of [ticket, 'not-a-ticket', '']) {
      const socket = open(attempt)
      outcomes.push(
        await new Promise<string>((resolve) => {
          socket.on('unexpected-response', (_request, response) =>
            resolve(`http ${response.statusCode}`))
          socket.on('error', (error: Error) => resolve(String(error)))
          socket.on('close', () => resolve('closed'))
          socket.on('open', () => resolve('opened'))
        }),
      )
      socket.terminate()
    }
    expect(outcomes).toEqual(['http 401', 'http 401', 'http 401'])

    const otherRun = open(await startSessionTicket(), 'run-that-is-not-this-one')
    const wrongRun = await new Promise<string>((resolve) => {
      otherRun.on('unexpected-response', (_request, response) => resolve(`http ${response.statusCode}`))
      otherRun.on('error', (error: Error) => resolve(String(error)))
      otherRun.on('open', () => resolve('opened'))
    })
    otherRun.terminate()
    expect(wrongRun).toBe('http 401')
  })

  it('refuses an upgrade from another origin', async () => {
    const ticket = await startSession()
    const socket = new WebSocket(
      `ws://${base}/api/runs/${RUN}/session/terminal?ticket=${ticket}`,
      { origin: 'http://evil.example' },
    )
    const failed = await new Promise<string>((resolve) => {
      socket.on('unexpected-response', (_request, response) => resolve(`http ${response.statusCode}`))
      socket.on('error', (error: Error) => resolve(String(error)))
      socket.on('close', () => resolve('closed'))
      socket.on('open', () => resolve('opened'))
    })
    socket.terminate()
    expect(failed).toBe('http 403')
  })
})
