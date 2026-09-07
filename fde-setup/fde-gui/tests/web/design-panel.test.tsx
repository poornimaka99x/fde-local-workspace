// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesignPanelForm } from '../../web/src/features/design/DesignPanelForm'
import { DesignPanelView } from '../../web/src/features/design/DesignPanelView'

interface Sent { url: string; method: string; body: unknown }

const sent: Sent[] = []

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  })
}

const accounts = {
  accounts: [
    {
      id: 'work', label: 'Claude: work', profile: 'work', provider: 'anthropic',
      profilePresent: true, authState: 'authenticated', authMethod: 'subscription',
      models: [{ id: 'default', label: 'Account default', efforts: ['auto', 'high'] }],
      capabilities: ['ui-ux-design'], designPanelEligible: true,
    },
    {
      id: 'msc', label: 'Claude: msc', profile: 'msc', provider: 'anthropic',
      profilePresent: true, authState: 'authenticated', authMethod: 'subscription',
      models: [{ id: 'default', label: 'Account default', efforts: ['auto', 'high'] }],
      capabilities: ['ui-ux-design'], designPanelEligible: true,
    },
    {
      id: 'alt', label: 'Claude: alt', profile: 'alt', provider: 'anthropic',
      profilePresent: true, authState: 'authenticated', authMethod: 'subscription',
      models: [{ id: 'default', label: 'Account default', efforts: ['auto', 'high'] }],
      capabilities: ['ui-ux-design'], designPanelEligible: true,
    },
    {
      id: 'plain', label: 'Claude: plain', profile: 'plain', provider: 'anthropic',
      profilePresent: true, authState: 'authenticated', authMethod: null,
      models: [{ id: 'default', label: 'Account default', efforts: ['auto'] }],
      capabilities: ['research'], designPanelEligible: false,
    },
  ],
}

const lenses = {
  schemaVersion: 1,
  lenses: [
    { id: 'flow', label: 'Product flow', text: 'flow lens' },
    { id: 'visual', label: 'Visual direction', text: 'visual lens' },
    { id: 'system', label: 'Design system', text: 'system lens' },
  ],
}

const packs = {
  schemaVersion: 1,
  packs: [
    {
      packId: 'taste', label: 'Taste', license: 'MIT', commit: 'e'.repeat(40),
      sourceUrl: 'https://example.invalid/taste', stability: 'experimental',
      stabilityNote: 'Upstream calls this an experimental pre-release.',
      changes: ['Adds an anti-generic visual direction.'], conflictsWith: ['impeccable'],
      dials: [{ id: 'variance', label: 'Design variance', min: 1, max: 10, default: 8, help: '1 airy, 10 chaotic' }],
      detector: null,
    },
    {
      packId: 'impeccable', label: 'Impeccable', license: 'Apache-2.0', commit: 'f'.repeat(40),
      sourceUrl: 'https://example.invalid/impeccable', stability: 'stable', stabilityNote: null,
      changes: ['Adds critique and audit lenses.'], conflictsWith: ['taste'], dials: [],
      detector: { enabled: false, enabledByDefault: false, engineVersion: '0.1.2' },
    },
  ],
}

const references = {
  schemaVersion: 1, available: true, source: 'https://example.invalid/catalog',
  commit: 'c'.repeat(40), license: 'MIT',
  warning: 'Inspiration, not authorisation to impersonate a brand.',
  entries: [{ id: 'linear.app', name: 'Linear', description: 'near-black canvas', sourceUrl: null, sha256: 'd'.repeat(64) }],
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method !== undefined && init.method !== 'GET') {
      sent.push({
        url, method: init.method,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      })
    }
    return handler(url, init)
  }))
}

const catalogHandler = (url: string): Response | null => {
  if (url === '/api/claude/accounts') return jsonResponse(accounts)
  if (url === '/api/design-panel/lenses') return jsonResponse(lenses)
  if (url === '/api/design-panel/packs') return jsonResponse(packs)
  if (url === '/api/design-panel/references') return jsonResponse(references)
  if (url === '/api/projects') {
    return jsonResponse({
      schemaVersion: 1,
      projects: [{ projectId: 'returns-a1b2', name: 'Returns', description: null, repoPaths: [] }],
      unassignedRunCount: 0, warnings: [],
    })
  }
  return null
}

beforeEach(() => {
  sent.length = 0
  window.sessionStorage.setItem('fde-gui-token', 'test-token')
  window.history.pushState(null, '', '/design-panel/new')
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.sessionStorage.clear()
})

describe('the design-panel form', () => {
  it('takes the run in one step and the sealed selection in the next', async () => {
    stubFetch((url, init) => {
      const catalog = catalogHandler(url)
      if (catalog !== null) return catalog
      if (url === '/api/runs' && init?.method === 'POST') {
        return jsonResponse({ schemaVersion: 1, run: { runId: '20260906-returns-aaaa' } }, 201)
      }
      if (url.endsWith('/attachments')) return jsonResponse({ schemaVersion: 1, attachments: [] })
      if (url.endsWith('/design-panel') && init?.method === 'POST') {
        return jsonResponse({ schemaVersion: 1, designPanel: { panelId: 'panel-abc12345' } }, 201)
      }
      return jsonResponse({}, 404)
    })
    const user = userEvent.setup()
    render(<DesignPanelForm />)

    // Step one: every control has a real label, and the brief is required.
    await waitFor(() => expect(screen.getByLabelText('Project')).toBeInTheDocument())
    await user.selectOptions(screen.getByLabelText('Project'), 'returns-a1b2')
    await user.type(screen.getByLabelText('Design brief'), 'Rework the returns screen.')
    await user.click(screen.getByRole('button', { name: 'Create the run' }))

    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatchObject({
      url: '/api/runs',
      method: 'POST',
      body: { shape: 'design-panel', projectId: 'returns-a1b2', orchestrator: 'work' },
    })

    // Step two: the sealing boundary is stated before anything is sealed.
    await waitFor(() =>
      expect(screen.getByText(/context is sealed when you create the panel/i)).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /Seal context and create the panel/ }))

    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]?.url).toBe('/api/runs/20260906-returns-aaaa/design-panel')
    const payload = sent[1]?.body as { participants: { accountId: string; lensId: string }[]; mode: string }
    expect(payload.participants).toHaveLength(3)
    expect(payload.participants.map((participant) => participant.accountId)).toEqual(['work', 'msc', 'alt'])
    expect(new Set(payload.participants.map((participant) => participant.lensId)).size).toBe(3)
    expect(payload.mode).toBe('independent')
  })

  it('offers only identities the registry says may design', async () => {
    stubFetch((url, init) => {
      const catalog = catalogHandler(url)
      if (catalog !== null) return catalog
      if (url === '/api/runs' && init?.method === 'POST') {
        return jsonResponse({ schemaVersion: 1, run: { runId: '20260906-returns-aaaa' } }, 201)
      }
      if (url.endsWith('/attachments')) return jsonResponse({ schemaVersion: 1, attachments: [] })
      return jsonResponse({}, 404)
    })
    const user = userEvent.setup()
    window.history.pushState(null, '', '/design-panel/new?runId=20260906-returns-aaaa')
    render(<DesignPanelForm />)

    await waitFor(() => expect(screen.getAllByLabelText('Account')).toHaveLength(3))
    const options = within(screen.getAllByLabelText('Account')[0]!).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      'Claude: work', 'Claude: msc', 'Claude: alt',
    ])
    expect(screen.queryByRole('option', { name: 'Claude: plain' })).toBeNull()
    await user.selectOptions(screen.getAllByLabelText('Account')[1]!, 'work')
    expect(await screen.findByText(/Each account may take part once/)).toBeInTheDocument()
  })

  it('shows a pack conflict and refuses to submit until the operator chooses', async () => {
    stubFetch((url) => catalogHandler(url) ?? jsonResponse({ schemaVersion: 1, attachments: [] }))
    const user = userEvent.setup()
    window.history.pushState(null, '', '/design-panel/new?runId=20260906-returns-aaaa')
    render(<DesignPanelForm />)

    await waitFor(() => expect(screen.getByLabelText(/Taste/)).toBeInTheDocument())
    await user.type(screen.getByLabelText(/Every participant receives exactly this text/),
      'Rework the returns screen.')
    expect(screen.getByText(/experimental pre-release/)).toBeInTheDocument()
    expect(screen.getByText(/executable detector stays off/)).toBeInTheDocument()

    await user.click(screen.getByLabelText(/Taste/))
    await user.click(screen.getByLabelText(/Impeccable/))
    const conflict = await screen.findByText(/give conflicting stylistic direction/)
    expect(conflict).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Seal context/ })).toBeDisabled()
    await user.click(screen.getByLabelText('Enable both anyway'))
    expect(screen.getByRole('button', { name: /Seal context/ })).toBeEnabled()
  })

  it('warns that a reference is inspiration, not permission', async () => {
    stubFetch((url) => catalogHandler(url) ?? jsonResponse({ schemaVersion: 1, attachments: [] }))
    window.history.pushState(null, '', '/design-panel/new?runId=20260906-returns-aaaa')
    render(<DesignPanelForm />)
    expect(await screen.findByText(/not authorisation to impersonate a brand/i)).toBeInTheDocument()
  })
})

const panelFixture = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  runId: '20260906-returns-aaaa',
  panelId: 'panel-abc12345',
  projectId: 'returns-a1b2',
  state: 'running',
  mode: 'independent',
  outputTarget: 'recommendation',
  createdAt: '2026-09-06T10:00:00+00:00',
  updatedAt: '2026-09-06T10:05:00+00:00',
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
  context: { contextSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), commonContextBytes: 4096 },
  contextManifest: {
    contextSha256: 'a'.repeat(64),
    inputFiles: [{
      attachmentId: '9f1c', originalName: 'receipt.png', mediaType: 'image/png',
      bytes: 2048, sha256: 'd'.repeat(64), passthrough: 'file',
    }],
    designReferences: [{
      referenceId: 'linear.app', role: 'primary', name: 'Linear', commit: 'c'.repeat(40),
      license: 'MIT', sha256: 'e'.repeat(64), truncated: false,
    }],
    guidancePacks: [],
    repositories: [],
  },
  participants: [
    {
      participantId: 'claude_work', agentId: 'claude_work', profile: 'work', label: 'Claude: work',
      model: 'default', effort: 'auto', lensId: 'flow', lensLabel: 'Product flow', lens: null,
      state: 'succeeded', attempts: 1, startedAt: null, endedAt: null, durationMs: 61000,
      error: null, proposalPath: 'artifacts/design-panel/proposals/claude_work.md',
      proposalPresent: true, proposalBytes: 900, commonContextSha256: 'a'.repeat(64),
      promptSha256: 'b'.repeat(64),
    },
    {
      participantId: 'claude_msc', agentId: 'claude_msc', profile: 'msc', label: 'Claude: msc',
      model: 'default', effort: 'auto', lensId: 'visual', lensLabel: 'Visual direction', lens: null,
      state: 'failed', attempts: 1, startedAt: null, endedAt: null, durationMs: 4000,
      error: 'This Claude account has reached a usage or rate limit.',
      proposalPath: null, proposalPresent: false, proposalBytes: null,
      commonContextSha256: 'a'.repeat(64), promptSha256: 'c'.repeat(64),
    },
    {
      participantId: 'claude_alt', agentId: 'claude_alt', profile: 'alt', label: 'Claude: alt',
      model: 'default', effort: 'auto', lensId: 'system', lensLabel: 'Design system', lens: null,
      state: 'pending', attempts: 0, startedAt: null, endedAt: null, durationMs: null,
      error: null, proposalPath: null, proposalPresent: false, proposalBytes: null,
      commonContextSha256: null, promptSha256: null,
    },
  ],
  succeededCount: 1,
  reconciliation: { state: 'pending' },
  artifacts: [
    { path: 'artifacts/design-panel/context-manifest.json', present: true },
    { path: 'artifacts/design-panel/final-design.md', present: false },
  ],
  comparisonDimensions: ['user flow', 'hierarchy', 'accessibility'],
  nextAction: 'start the remaining participants: claude_alt',
  ...overrides,
})

describe('the design-panel page', () => {
  const renderPanel = (overrides: Record<string, unknown> = {}): void => {
    stubFetch((url) => {
      if (url.endsWith('/design-panel')) {
        return jsonResponse({ schemaVersion: 1, designPanel: panelFixture(overrides) })
      }
      return jsonResponse({}, 404)
    })
    window.history.pushState(null, '', '/runs/20260906-returns-aaaa/design-panel')
    render(<DesignPanelView runId="20260906-returns-aaaa" />)
  }

  it('says every state in words, never in colour alone', async () => {
    renderPanel()
    expect(await screen.findByText('proposal in')).toBeInTheDocument()
    expect(screen.getByText('failed')).toBeInTheDocument()
    expect(screen.getByText('not started')).toBeInTheDocument()
    // The mark beside each word is decorative; the word is the information.
    const marks = document.querySelectorAll('[aria-hidden="true"]')
    expect(marks.length).toBeGreaterThan(0)
  })

  it('announces status changes politely', async () => {
    renderPanel()
    await screen.findByText('proposal in')
    const live = document.querySelector('[role="status"][aria-live="polite"]')
    expect(live).not.toBeNull()
  })

  it('shows the sealed context digest and each account that shares it', async () => {
    renderPanel()
    expect(await screen.findByText(/identical for every participant/)).toBeInTheDocument()
    expect(screen.getByText('Context SHA-256')).toBeInTheDocument()
    expect(screen.getByText(/receipt\.png/)).toBeInTheDocument()
    expect(screen.getByText(/passed as a file/)).toBeInTheDocument()
    expect(screen.getByText(/not authorisation to impersonate a brand/i)).toBeInTheDocument()
  })

  it('keeps a successful proposal available beside a failure', async () => {
    renderPanel()
    expect(await screen.findByText('Proposal — Claude: work')).toBeInTheDocument()
    expect(screen.getByText(/usage or rate limit/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(3)
  })

  it('offers start, stop and retry only where the controller allows them', async () => {
    renderPanel()
    await screen.findByText('proposal in')
    const cards = screen.getAllByRole('region')
    const pending = cards.find((card) => card.getAttribute('aria-label')?.includes('pending'))
    expect(pending).toBeDefined()
    expect(within(pending!).getByRole('button', { name: 'Start' })).toBeEnabled()
    expect(within(pending!).getByRole('button', { name: 'Stop' })).toBeDisabled()
    const failedCard = cards.find((card) => card.getAttribute('aria-label')?.includes('failed'))
    expect(within(failedCard!).getByRole('button', { name: 'Retry' })).toBeEnabled()
    expect(within(failedCard!).getByRole('button', { name: 'Start' })).toBeDisabled()
  })

  it('starts a participant through the API and reloads', async () => {
    const started: string[] = []
    stubFetch((url, init) => {
      if (init?.method === 'POST') {
        started.push(url)
        return jsonResponse({ schemaVersion: 1, designPanel: panelFixture() })
      }
      if (url.endsWith('/design-panel')) {
        return jsonResponse({ schemaVersion: 1, designPanel: panelFixture() })
      }
      return jsonResponse({}, 404)
    })
    const user = userEvent.setup()
    render(<DesignPanelView runId="20260906-returns-aaaa" />)
    await screen.findByText('not started')
    const cards = screen.getAllByRole('region')
    const pending = cards.find((card) => card.getAttribute('aria-label')?.includes('pending'))!
    await user.click(within(pending).getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(started).toContain(
      '/api/runs/20260906-returns-aaaa/design-panel/participants/claude_alt/start'))
  })

  it('tells the operator to type the approval rather than offering a button', async () => {
    renderPanel({ rolesConfirmed: false, pendingRoles: ['solutioning', 'review'] })
    expect(await screen.findByText(/waiting for your approval/i)).toBeInTheDocument()
    expect(screen.getByText(/APPROVE PLAN 20260906-returns-aaaa/)).toBeInTheDocument()
    expect(screen.getByText(/solutioning, review/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull()
  })

  it('explains a degraded reconciliation instead of quietly allowing it', async () => {
    renderPanel({
      state: 'awaiting_reconciliation', reconcileStageReady: true, succeededCount: 1,
    })
    expect(await screen.findByText(/Only one proposal succeeded/)).toBeInTheDocument()
    expect(screen.getByText(/fde design-panel approve-degraded/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reconcile the panel/ })).toBeDisabled()
  })

  it('allows reconciliation once two proposals are in and the stage is right', async () => {
    renderPanel({
      state: 'awaiting_reconciliation', reconcileStageReady: true, succeededCount: 2,
    })
    await screen.findByText(/2 of 3 proposals succeeded/)
    expect(screen.getByRole('button', { name: /Reconcile the panel/ })).toBeEnabled()
    expect(screen.getByText(/information barrier is closed/)).toBeInTheDocument()
  })
})

describe('the stylesheet', () => {
  const css = readFileSync(
    path.join(process.cwd(), 'web', 'src', 'styles.css'), 'utf8')

  it('honours a reduced-motion preference', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('lays out for a narrow screen', () => {
    expect(css).toMatch(/@media \(max-width: 700px\)/)
    expect(css).toContain('.visually-hidden')
  })
})
