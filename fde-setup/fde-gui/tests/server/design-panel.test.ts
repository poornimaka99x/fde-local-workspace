import { afterEach, describe, expect, it } from 'vitest'
import { authed, makeHarness, type Harness } from './harness'
import type { PanelCommandRunner, RunningPanelCommand } from '../../server/src/services/design-panel'

/**
 * The design-panel API against a stub controller and a stub account runner.
 *
 * Nothing here starts a real `fde`, `claude` or `codex`, reads the operator's
 * profiles, or touches the network. What is being checked is the boundary: what
 * the browser may choose, what reaches argv, what environment a participant
 * gets, and what never comes back out.
 */

const RUN = '20260906-returns-aaaa'

let harness: Harness | null = null

afterEach(async () => {
  await harness?.destroy()
  harness = null
})

function panelEnvelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    designPanel: {
      schemaVersion: 2,
      runId: RUN,
      panelId: 'panel-abc12345',
      projectId: 'returns-a1b2',
      state: 'configured',
      mode: 'independent',
      outputTarget: 'recommendation',
      createdAt: '2026-09-06T10:00:00+00:00',
      updatedAt: '2026-09-06T10:00:00+00:00',
      brief: 'Rework the returns screen.',
      rolesConfirmed: true,
      pendingRoles: [],
      designerRole: ['claude_work', 'claude_msc'],
      runState: 'solutioning',
      conceptStageReady: true,
      reconcileStageReady: false,
      barrierOpenedAt: null,
      degradedApprovedAt: null,
      packConflictAcknowledged: false,
      packs: {},
      references: [],
      context: { contextSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), commonContextBytes: 2048 },
      contextManifest: { contextSha256: 'a'.repeat(64) },
      participants: [
        {
          participantId: 'claude_work', agentId: 'claude_work', profile: 'work',
          label: 'Claude: work', model: 'default', effort: 'auto', lensId: 'flow',
          lensLabel: 'Product flow', state: 'pending', attempts: 0,
          proposalPresent: false, prototypePresent: false, order: 0, handoffFrom: [],
        },
        {
          participantId: 'claude_msc', agentId: 'claude_msc', profile: 'msc',
          label: 'Claude: msc', model: 'default', effort: 'auto', lensId: 'visual',
          lensLabel: 'Visual direction', state: 'pending', attempts: 0,
          proposalPresent: false, prototypePresent: false, order: 1, handoffFrom: [],
        },
      ],
      succeededCount: 0,
      reconciliation: { state: 'pending' },
      artifacts: [],
      comparisonDimensions: ['user flow', 'accessibility'],
      handoffOrder: ['claude_work', 'claude_msc'],
      mediaFiles: [],
      nextAction: 'start the remaining participants',
      ...overrides,
    },
  }
}

function seedCatalogs(target: Harness): void {
  target.fixture('design-panel-lenses', {
    schemaVersion: 1,
    lenses: [
      { id: 'flow', label: 'Product flow', text: 'flow lens' },
      { id: 'visual', label: 'Visual direction', text: 'visual lens' },
      { id: 'system', label: 'Design system', text: 'system lens' },
    ],
  })
  target.fixture('design-panel-references', {
    schemaVersion: 1,
    available: true,
    source: 'https://github.com/voltagent/awesome-design-md',
    commit: 'c'.repeat(40),
    license: 'MIT',
    warning: 'Inspiration, not authorisation to impersonate a brand.',
    entries: [{ id: 'linear.app', name: 'Linear', description: 'dark', sourceUrl: null, sha256: 'd'.repeat(64) }],
  })
  target.fixture('design-panel-packs', {
    schemaVersion: 1,
    packs: [
      {
        packId: 'taste', label: 'Taste', license: 'MIT', commit: 'e'.repeat(40),
        sourceUrl: 'https://github.com/leonxlnx/taste-skill', stability: 'experimental',
        stabilityNote: 'upstream calls v2 experimental', changes: ['anti-generic direction'],
        conflictsWith: ['impeccable'],
        dials: [{ id: 'variance', label: 'Design variance', min: 1, max: 10, default: 8, help: '' }],
        detector: null,
      },
      {
        packId: 'impeccable', label: 'Impeccable', license: 'Apache-2.0', commit: 'f'.repeat(40),
        sourceUrl: 'https://github.com/pbakaus/impeccable', stability: 'stable',
        stabilityNote: null, changes: ['critique and audit'], conflictsWith: ['taste'],
        dials: [], detector: { enabled: false, enabledByDefault: false, engineVersion: '0.1.2' },
      },
    ],
  })
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    brief: 'Rework the in-store returns screen.',
    participants: [
      { accountId: 'work', model: 'default', effort: 'auto', lensId: 'flow' },
      { accountId: 'msc', model: 'default', effort: 'auto', lensId: 'visual' },
    ],
    mode: 'independent',
    outputTarget: 'recommendation',
    ...overrides,
  }
}

async function post(target: Harness, url: string, payload?: unknown) {
  return await target.app.inject({
    method: 'POST',
    url,
    headers: { ...authed(target.token), origin: 'http://127.0.0.1:7317' },
    payload: payload as object | undefined,
  })
}

async function makePanelHarness(options: {
  panelRunner?: PanelCommandRunner
  panelTimeoutMs?: number
} = {}): Promise<Harness> {
  const created = await makeHarness({ withDesignRegistry: true, ...options })
  seedCatalogs(created)
  return created
}

const settle = async (check: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('what the browser may choose', () => {
  it('offers only the identities the registry says may design', async () => {
    harness = await makePanelHarness()
    const response = await harness.app.inject({
      method: 'GET', url: '/api/claude/accounts', headers: authed(harness.token),
    })
    const accounts = (response.json() as {
      accounts: { id: string; designPanelEligible: boolean; capabilities: string[] }[]
    }).accounts
    const eligible = accounts.filter((account) => account.designPanelEligible).map((a) => a.id)
    expect(eligible.sort()).toEqual(['alt', 'msc', 'work'])
    expect(accounts.find((account) => account.id === 'plain')?.designPanelEligible).toBe(false)
    expect(accounts.find((account) => account.id === 'codex')?.designPanelEligible).toBe(false)
  })

  it('refuses the same account twice', async () => {
    harness = await makePanelHarness()
    const response = await post(harness, `/api/runs/${RUN}/design-panel`, body({
      participants: [
        { accountId: 'work', model: 'default', effort: 'auto', lensId: 'flow' },
        { accountId: 'work', model: 'default', effort: 'auto', lensId: 'visual' },
      ],
    }))
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ type: 'about:fde/duplicate-account' })
  })

  it('refuses two participants sharing one lens', async () => {
    harness = await makePanelHarness()
    const response = await post(harness, `/api/runs/${RUN}/design-panel`, body({
      participants: [
        { accountId: 'work', model: 'default', effort: 'auto', lensId: 'flow' },
        { accountId: 'msc', model: 'default', effort: 'auto', lensId: 'flow' },
      ],
    }))
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ type: 'about:fde/duplicate-lens' })
  })

  it('refuses an identity the registry did not grant the capability', async () => {
    harness = await makePanelHarness()
    const response = await post(harness, `/api/runs/${RUN}/design-panel`, body({
      participants: [
        { accountId: 'work', model: 'default', effort: 'auto', lensId: 'flow' },
        { accountId: 'plain', model: 'default', effort: 'auto', lensId: 'visual' },
      ],
    }))
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ type: 'about:fde/ineligible-account' })
  })

  it('refuses a model and effort the account does not offer', async () => {
    harness = await makePanelHarness()
    const response = await post(harness, `/api/runs/${RUN}/design-panel`, body({
      participants: [
        { accountId: 'work', model: 'haiku', effort: 'xhigh', lensId: 'flow' },
        { accountId: 'msc', model: 'default', effort: 'auto', lensId: 'visual' },
      ],
    }))
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ type: 'about:fde/invalid-selection' })
  })

  it('refuses a lens, reference, pack or dial this console never offered', async () => {
    harness = await makePanelHarness()
    const cases: [Record<string, unknown>, string][] = [
      [{ participants: [
        { accountId: 'work', model: 'default', effort: 'auto', lensId: 'vibes' },
        { accountId: 'msc', model: 'default', effort: 'auto', lensId: 'visual' },
      ] }, 'about:fde/unknown-lens'],
      [{ referenceIds: ['not-a-brand'] }, 'about:fde/unknown-reference'],
      [{ packs: { nonsense: {} } }, 'about:fde/unknown-pack'],
      [{ packs: { taste: { loudness: 4 } } }, 'about:fde/unknown-dial'],
      [{ packs: { taste: { variance: 99 } } }, 'about:fde/invalid-dial'],
    ]
    for (const [overrides, type] of cases) {
      const response = await post(harness, `/api/runs/${RUN}/design-panel`, body(overrides))
      expect(response.statusCode, JSON.stringify(overrides)).toBe(400)
      expect(response.json()).toMatchObject({ type })
    }
  })

  it('shows a pack conflict instead of silently enabling both', async () => {
    harness = await makePanelHarness()
    harness.fixture(`design-panel-create-${RUN}`, panelEnvelope())
    const refused = await post(harness, `/api/runs/${RUN}/design-panel`,
      body({ packs: { taste: { variance: 8 }, impeccable: {} } }))
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ type: 'about:fde/pack-conflict' })

    const accepted = await post(harness, `/api/runs/${RUN}/design-panel`,
      body({ packs: { taste: { variance: 8 }, impeccable: {} }, acknowledgePackConflict: true }))
    expect(accepted.statusCode).toBe(201)
    const call = harness.calls().find((argv) => argv[1] === 'create')
    expect(call).toContain('--acknowledge-pack-conflict')
  })

  it('refuses a panel with fewer than two or more than three participants', async () => {
    harness = await makePanelHarness()
    for (const count of [1, 4]) {
      const participants = ['work', 'msc', 'alt', 'plain'].slice(0, count).map((accountId, index) => ({
        accountId, model: 'default', effort: 'auto', lensId: ['flow', 'visual', 'system', 'flow'][index],
      }))
      const response = await post(harness, `/api/runs/${RUN}/design-panel`, body({ participants }))
      expect(response.statusCode).toBe(400)
    }
  })

  it('refuses an empty brief', async () => {
    harness = await makePanelHarness()
    const response = await post(harness, `/api/runs/${RUN}/design-panel`, body({ brief: '   ' }))
    expect(response.statusCode).toBe(400)
  })

  it('needs the launch token like everything else', async () => {
    harness = await makePanelHarness()
    const response = await harness.app.inject({
      method: 'GET', url: `/api/runs/${RUN}/design-panel`,
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('creating a panel', () => {
  it('sends the selection as arguments and the brief on stdin', async () => {
    harness = await makePanelHarness()
    harness.fixture(`design-panel-create-${RUN}`, panelEnvelope())
    const response = await post(harness, `/api/runs/${RUN}/design-panel`, body({
      participants: [
        { accountId: 'work', model: 'opus', effort: 'high', lensId: 'flow', lens: 'follow the receipt' },
        { accountId: 'msc', model: 'default', effort: 'auto', lensId: 'visual' },
      ],
      referenceIds: ['linear.app'],
      attachmentIds: ['9f1c00aa'],
      includeProductMd: true,
      outputTarget: 'design-to-code',
    }))
    expect(response.statusCode).toBe(201)

    const argv = harness.calls().find((call) => call[1] === 'create') ?? []
    expect(argv.slice(0, 3)).toEqual(['design-panel', 'create', RUN])
    expect(argv).toContain('--brief-stdin')
    expect(argv).toContain('work:flow:high:opus')
    expect(argv).toContain('msc:visual:auto:default')
    expect(argv).toContain('claude_work=follow the receipt')
    expect(argv).toContain('--reference')
    expect(argv).toContain('linear.app')
    expect(argv).toContain('--include-product-md')
    expect(argv).not.toContain('--include-design-md')
    expect(argv).toContain('design-to-code')
    // Feature detection, not assumption: the stub CLI documents no file flag.
    expect(argv[argv.indexOf('--media-support') + 1]).toBe('none')
    expect(harness.stdinFor(`design-panel-create-${RUN}`)?.toString('utf8'))
      .toBe('Rework the in-store returns screen.')
  })

  it('refuses a model this account was never offered', async () => {
    harness = await makePanelHarness()
    harness.fixture(`design-panel-create-${RUN}`, panelEnvelope())
    // Syntactically valid, and not in the account's list. The browser may only
    // choose from what this server offered it, so it is refused here rather
    // than forwarded to the controller.
    const response = await post(harness, `/api/runs/${RUN}/design-panel`, body({
      participants: [
        { accountId: 'work', model: 'claude-opus-9-secret', effort: 'high', lensId: 'flow' },
        { accountId: 'msc', model: 'default', effort: 'auto', lensId: 'visual' },
      ],
    }))
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ type: 'about:fde/invalid-selection' })
    expect(harness.calls().some((call) => call[1] === 'create')).toBe(false)
  })

  it('refuses an effort the selected model does not offer', async () => {
    harness = await makePanelHarness()
    harness.fixture(`design-panel-create-${RUN}`, panelEnvelope())
    const response = await post(harness, `/api/runs/${RUN}/design-panel`, body({
      participants: [
        // xhigh is Opus-specific; Sonnet does not offer it.
        { accountId: 'work', model: 'sonnet', effort: 'xhigh', lensId: 'flow' },
        { accountId: 'msc', model: 'default', effort: 'auto', lensId: 'visual' },
      ],
    }))
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ type: 'about:fde/invalid-selection' })
  })

  it('refuses a controller answer in an unexpected shape', async () => {
    harness = await makePanelHarness()
    harness.rawFixture(`design-panel-create-${RUN}`, JSON.stringify({ schemaVersion: 9 }))
    const response = await post(harness, `/api/runs/${RUN}/design-panel`, body())
    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ type: 'about:fde/controller-unexpected-shape' })
  })

  it("passes a controller refusal on in the controller's own words", async () => {
    harness = await makePanelHarness()
    harness.failure(`design-panel-create-${RUN}`, 2,
      'fde: claude_msc is listed twice. A panel is several accounts working the same brief.')
    const response = await post(harness, `/api/runs/${RUN}/design-panel`, body())
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ detail: expect.stringContaining('listed twice') })
  })
})

interface Started { file: string; args: string[]; env: NodeJS.ProcessEnv }

function recordingRunner(started: Started[], behaviour: 'reply' | 'hang' = 'reply'): PanelCommandRunner {
  return (options) => {
    started.push({ file: options.file, args: options.args, env: options.env })
    let release: (() => void) | null = null
    const completed = new Promise<{ code: number; stdout: string }>((resolve) => {
      if (behaviour === 'reply') {
        setTimeout(() => resolve({
          code: 0,
          stdout: JSON.stringify({ result: '## Design read\n\nSplit view.\n' }),
        }), 5)
        return
      }
      release = () => resolve({ code: 143, stdout: '' })
    })
    const command: RunningPanelCommand = { completed, kill: () => release?.() }
    return command
  }
}

function startFixture(target: Harness, runId: string, participantId: string): void {
  target.fixture(`design-panel-start-${runId}-${participantId}`, {
    schemaVersion: 1,
    runId,
    panelId: 'panel-abc12345',
    participantId,
    agentId: participantId,
    profile: participantId.replace('claude_', ''),
    model: 'default',
    effort: 'auto',
    lensId: 'flow',
    attempt: 1,
    commonContextSha256: 'a'.repeat(64),
    promptSha256: 'b'.repeat(64),
    promptBytes: 2048,
    prompt: 'SHARED CONTEXT BYTES\n\nYour lens is flow',
    mediaPaths: [],
    proposalPath: `artifacts/design-panel/proposals/${participantId}.md`,
  })
  target.fixture(`design-panel-record-${runId}-${participantId}`, panelEnvelope())
}

describe('running participants', () => {
  it('runs the account in its own profile, with no secret from this shell', async () => {
    const started: Started[] = []
    process.env.FDE_TEST_PANEL_SECRET = 'never-pass-this-on'
    harness = await makePanelHarness({ panelRunner: recordingRunner(started) })
    harness.fixture(`design-panel-show-${RUN}`, panelEnvelope())
    startFixture(harness, RUN, 'claude_msc')

    const response = await post(harness,
      `/api/runs/${RUN}/design-panel/participants/claude_msc/start`)
    expect(response.statusCode).toBe(200)
    await settle(() => started.length === 1, 'the account to be started')
    delete process.env.FDE_TEST_PANEL_SECRET

    const call = started[0]!
    expect(call.file).toBe(harness.config.claudeBin)
    expect(call.env.CLAUDE_CONFIG_DIR).toBe(`${harness.config.profilesRoot}/msc`)
    expect(call.env.CLAUDE_PROFILE).toBe('msc')
    expect(call.env.FDE_TEST_PANEL_SECRET).toBeUndefined()
    expect(Object.keys(call.env)).not.toContain('AWS_SECRET_ACCESS_KEY')
    // A conversation, not a session with tools: it cannot touch a repository.
    expect(call.args).toContain('--tools')
    expect(call.args[call.args.indexOf('--tools') + 1]).toBe('')
    expect(call.args).toContain('--restricted')
    expect(call.args).toContain('--strict-mcp-config')
    expect(call.args).toContain('--permission-mode')
  })

  it('never returns the prompt to the browser', async () => {
    const started: Started[] = []
    harness = await makePanelHarness({ panelRunner: recordingRunner(started) })
    harness.fixture(`design-panel-show-${RUN}`, panelEnvelope())
    startFixture(harness, RUN, 'claude_work')
    const response = await post(harness,
      `/api/runs/${RUN}/design-panel/participants/claude_work/start`)
    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain('SHARED CONTEXT BYTES')
    expect(response.body).not.toContain('Your lens is flow')
  })

  it('hands the answer back to the controller on stdin', async () => {
    const started: Started[] = []
    harness = await makePanelHarness({ panelRunner: recordingRunner(started) })
    harness.fixture(`design-panel-show-${RUN}`, panelEnvelope())
    startFixture(harness, RUN, 'claude_work')
    await post(harness, `/api/runs/${RUN}/design-panel/participants/claude_work/start`)
    await settle(
      () => harness?.calls().some((call) => call[1] === 'record') === true,
      'the proposal to be recorded',
    )
    const argv = harness.calls().find((call) => call[1] === 'record') ?? []
    expect(argv).toEqual(expect.arrayContaining([
      'design-panel', 'record', RUN, 'claude_work', '--status', 'ok', '--stdin',
    ]))
    expect(harness.stdinFor(`design-panel-record-${RUN}-claude_work`)?.toString('utf8'))
      .toContain('Split view.')
  })

  it('records a safe failure when the account refuses, and never its raw output', async () => {
    const runner: PanelCommandRunner = () => ({
      completed: Promise.resolve({
        code: 1,
        stdout: 'Error: not logged in. token sk-ant-secret-value',
      }),
      kill: () => undefined,
    })
    harness = await makePanelHarness({ panelRunner: runner })
    harness.fixture(`design-panel-show-${RUN}`, panelEnvelope())
    startFixture(harness, RUN, 'claude_work')
    await post(harness, `/api/runs/${RUN}/design-panel/participants/claude_work/start`)
    await settle(
      () => harness?.calls().some((call) => call[1] === 'record') === true,
      'the failure to be recorded',
    )
    const argv = harness.calls().find((call) => call[1] === 'record') ?? []
    const reason = argv[argv.indexOf('--error') + 1] ?? ''
    expect(argv).toContain('failed')
    expect(reason).toContain('not logged in')
    expect(reason).not.toContain('sk-ant-secret-value')
  })

  it("runs no more than the console's limit at once", async () => {
    const started: Started[] = []
    harness = await makePanelHarness({ panelRunner: recordingRunner(started, 'hang') })
    harness.fixture(`design-panel-show-${RUN}`, panelEnvelope())
    for (const participant of ['claude_work', 'claude_msc', 'claude_alt']) {
      startFixture(harness, RUN, participant)
    }
    const other = '20260906-other-bbbb'
    harness.fixture(`design-panel-show-${other}`, panelEnvelope())
    startFixture(harness, other, 'claude_work')

    for (const participant of ['claude_work', 'claude_msc', 'claude_alt']) {
      const accepted = await post(harness,
        `/api/runs/${RUN}/design-panel/participants/${participant}/start`)
      expect(accepted.statusCode).toBe(200)
    }
    await settle(() => started.length === 3, 'three participants to be running')
    const refused = await post(harness,
      `/api/runs/${other}/design-panel/participants/claude_work/start`)
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ type: 'about:fde/panel-busy' })
    expect(started).toHaveLength(3)
  })

  it('holds the limit when starts arrive together, not just one after another', async () => {
    const started: Started[] = []
    harness = await makePanelHarness({ panelRunner: recordingRunner(started, 'hang') })
    harness.fixture(`design-panel-show-${RUN}`, panelEnvelope())
    for (const participant of ['claude_work', 'claude_msc', 'claude_alt']) {
      startFixture(harness, RUN, participant)
    }
    const other = '20260906-other-bbbb'
    harness.fixture(`design-panel-show-${other}`, panelEnvelope())
    startFixture(harness, other, 'claude_work')
    startFixture(harness, other, 'claude_msc')

    // Five starts in flight at once, across two panels. The check and the
    // reservation have to happen in one step: a limit taken only after the
    // controller answers is a limit two simultaneous requests can walk past.
    const responses = await Promise.all([
      post(harness, `/api/runs/${RUN}/design-panel/participants/claude_work/start`),
      post(harness, `/api/runs/${RUN}/design-panel/participants/claude_msc/start`),
      post(harness, `/api/runs/${RUN}/design-panel/participants/claude_alt/start`),
      post(harness, `/api/runs/${other}/design-panel/participants/claude_work/start`),
      post(harness, `/api/runs/${other}/design-panel/participants/claude_msc/start`),
    ])
    const accepted = responses.filter((response) => response.statusCode === 200)
    const refused = responses.filter((response) => response.statusCode === 409)
    expect(accepted).toHaveLength(harness.config.panelConcurrency)
    expect(refused).toHaveLength(5 - harness.config.panelConcurrency)
    expect(refused[0]?.json()).toMatchObject({ type: 'about:fde/panel-busy' })
    await settle(() => started.length === harness!.config.panelConcurrency,
      'the accepted participants to be running')
    // Give any surplus process a chance to appear before asserting none did.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(started).toHaveLength(harness.config.panelConcurrency)
  })

  it('frees the slot it reserved when the controller refuses the start', async () => {
    const started: Started[] = []
    harness = await makePanelHarness({ panelRunner: recordingRunner(started, 'hang') })
    harness.fixture(`design-panel-show-${RUN}`, panelEnvelope())
    for (const participant of ['claude_work', 'claude_msc', 'claude_alt']) {
      startFixture(harness, RUN, participant)
    }
    const other = '20260906-other-bbbb'
    harness.fixture(`design-panel-show-${other}`, panelEnvelope())
    harness.failure(`design-panel-start-${other}-claude_work`, 5,
      'fde: claude_work is already running')

    const refused = await post(harness,
      `/api/runs/${other}/design-panel/participants/claude_work/start`)
    expect(refused.statusCode).toBeGreaterThanOrEqual(400)
    expect(harness.designPanels.isRunning(other, 'claude_work')).toBe(false)

    // A reservation that outlived its refused start would leak a slot, and the
    // console would run one participant fewer for the rest of its life.
    for (const participant of ['claude_work', 'claude_msc', 'claude_alt']) {
      const accepted = await post(harness,
        `/api/runs/${RUN}/design-panel/participants/${participant}/start`)
      expect(accepted.statusCode).toBe(200)
    }
    await settle(() => started.length === 3, 'all three slots to be usable')
  })

  it('stops a running participant and tells the controller', async () => {
    const started: Started[] = []
    harness = await makePanelHarness({ panelRunner: recordingRunner(started, 'hang') })
    harness.fixture(`design-panel-show-${RUN}`, panelEnvelope())
    startFixture(harness, RUN, 'claude_work')
    harness.fixture(`design-panel-stop-${RUN}-claude_work`, panelEnvelope())
    await post(harness, `/api/runs/${RUN}/design-panel/participants/claude_work/start`)
    await settle(() => started.length === 1, 'the participant to start')
    const stopped = await post(harness,
      `/api/runs/${RUN}/design-panel/participants/claude_work/stop`)
    expect(stopped.statusCode).toBe(200)
    expect(harness.calls().some((call) => call[1] === 'stop')).toBe(true)
  })

  it('gives up on a participant that runs past the ceiling', async () => {
    const started: Started[] = []
    harness = await makePanelHarness({
      panelRunner: recordingRunner(started, 'hang'),
      panelTimeoutMs: 60,
    })
    harness.fixture(`design-panel-show-${RUN}`, panelEnvelope())
    startFixture(harness, RUN, 'claude_work')
    await post(harness, `/api/runs/${RUN}/design-panel/participants/claude_work/start`)
    await settle(
      () => harness?.calls().some((call) => call[1] === 'record') === true,
      'the timeout to be recorded',
    )
  })

  it('retries through the controller', async () => {
    harness = await makePanelHarness()
    harness.fixture(`design-panel-show-${RUN}`, panelEnvelope())
    harness.fixture(`design-panel-retry-${RUN}-claude_work`, panelEnvelope())
    const response = await post(harness,
      `/api/runs/${RUN}/design-panel/participants/claude_work/retry`)
    expect(response.statusCode).toBe(200)
    expect(harness.calls().some((call) => call[1] === 'retry')).toBe(true)
  })

  it('refuses a participant id that is not one', async () => {
    harness = await makePanelHarness()
    const response = await post(harness,
      `/api/runs/${RUN}/design-panel/participants/${encodeURIComponent('../../etc/passwd')}/start`)
    expect(response.statusCode).toBe(400)
  })
})

describe('surviving a restart', () => {
  it('turns work with no process behind it into a retryable interruption', async () => {
    harness = await makePanelHarness()
    harness.fixture(`design-panel-show-${RUN}`, panelEnvelope({
      state: 'running',
      participants: [
        {
          participantId: 'claude_work', agentId: 'claude_work', profile: 'work',
          label: 'Claude: work', model: 'default', effort: 'auto', lensId: 'flow',
          lensLabel: 'flow', state: 'running', attempts: 1, proposalPresent: false,
        },
      ],
    }))
    harness.fixture(`design-panel-recover-${RUN}`, {
      schemaVersion: 1, runId: RUN, recovered: ['claude_work'],
    })
    const response = await harness.app.inject({
      method: 'GET', url: `/api/runs/${RUN}/design-panel`, headers: authed(harness.token),
    })
    expect(response.statusCode).toBe(200)
    expect(harness.calls().some((call) => call[1] === 'recover')).toBe(true)
  })

  it('leaves work this console is actually running alone', async () => {
    const started: Started[] = []
    harness = await makePanelHarness({ panelRunner: recordingRunner(started, 'hang') })
    harness.fixture(`design-panel-show-${RUN}`, panelEnvelope())
    startFixture(harness, RUN, 'claude_work')
    await post(harness, `/api/runs/${RUN}/design-panel/participants/claude_work/start`)
    await settle(() => started.length === 1, 'the participant to start')
    harness.fixture(`design-panel-show-${RUN}`, panelEnvelope({
      participants: [{
        participantId: 'claude_work', agentId: 'claude_work', profile: 'work',
        label: 'Claude: work', model: 'default', effort: 'auto', lensId: 'flow',
        lensLabel: 'flow', state: 'running', attempts: 1, proposalPresent: false,
      }],
    }))
    await harness.app.inject({
      method: 'GET', url: `/api/runs/${RUN}/design-panel`, headers: authed(harness.token),
    })
    expect(harness.calls().some((call) => call[1] === 'recover')).toBe(false)
  })
})

describe('reconciliation', () => {
  it('runs the orchestrator account and records the answer', async () => {
    const started: Started[] = []
    const runner: PanelCommandRunner = (options) => {
      started.push({ file: options.file, args: options.args, env: options.env })
      return {
        completed: Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ result: '## Comparison\n\nx\n\n## Reconciliation\n\ny\n' }),
        }),
        kill: () => undefined,
      }
    }
    harness = await makePanelHarness({ panelRunner: runner })
    harness.fixture(`design-panel-show-${RUN}`, panelEnvelope({ state: 'awaiting_reconciliation' }))
    harness.fixture(`design-panel-reconcile-${RUN}`, {
      schemaVersion: 1, runId: RUN, panelId: 'panel-abc12345', agentId: 'claude_work',
      profile: 'work', model: 'default', effort: 'auto', degraded: false,
      commonContextSha256: 'a'.repeat(64), promptSha256: 'c'.repeat(64), promptBytes: 100,
      prompt: 'RECONCILE THESE PROPOSALS',
    })
    harness.fixture(`design-panel-record-reconciliation-${RUN}`, panelEnvelope({ state: 'complete' }))

    const response = await post(harness, `/api/runs/${RUN}/design-panel/reconcile`)
    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain('RECONCILE THESE PROPOSALS')
    await settle(
      () => harness?.calls().some((call) => call[1] === 'record-reconciliation') === true,
      'the reconciliation to be recorded',
    )
    expect(started[0]?.env.CLAUDE_CONFIG_DIR).toBe(`${harness.config.profilesRoot}/work`)
  })

  it('passes a controller refusal on rather than reconciling anyway', async () => {
    harness = await makePanelHarness()
    harness.fixture(`design-panel-show-${RUN}`, panelEnvelope())
    harness.failure(`design-panel-reconcile-${RUN}`, 7,
      'fde: only 1 proposal succeeded. Retry a participant, or approve a degraded reconciliation')
    const response = await post(harness, `/api/runs/${RUN}/design-panel/reconcile`)
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      detail: expect.stringContaining('degraded reconciliation'),
    })
  })
})
