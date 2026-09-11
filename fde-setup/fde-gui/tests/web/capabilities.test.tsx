// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilitiesView } from '../../web/src/features/configuration/CapabilitiesView'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const items = [
  { id: 'skill:fde-core:implementation', kind: 'skill', name: 'implementation',
    description: 'Implement an approved change.', origin: 'built-in', plugin: 'fde-core',
    source: '~/.claude-shared/fde-toolkit/plugins/fde-core/skills/implementation/SKILL.md', tools: ['Read', 'Write'], enabled: true, toggleable: true },
  { id: 'agent:fde-core:reviewer', kind: 'agent', name: 'reviewer',
    description: 'Review a bounded change.', origin: 'built-in', plugin: 'fde-core',
    source: '~/.claude-shared/fde-toolkit/plugins/fde-core/agents/reviewer.md', tools: ['Read'], enabled: true, toggleable: true },
  { id: 'mcp:context7', kind: 'mcp', name: 'context7', description: 'Versioned documentation.',
    origin: 'built-in', plugin: null, source: '~/.claude-shared/mcp/mcp-servers.json', tools: [], enabled: true, toggleable: true },
]
const catalog = { schemaVersion: 1, extensionRoot: '/tmp/plugins', items,
  counts: { plugin: 0, skill: 1, agent: 1, mcp: 1, tool: 0, command: 0, hook: 0, script: 0 }, warnings: [] }

describe('capabilities and extensions panel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input) === '/api/configuration/capabilities') return response(catalog)
      if (String(input) === '/api/configuration/skills' && init?.method === 'POST') {
        return response({ ...catalog, items: [...items, { ...items[0], id: 'skill:fde-user:release-notes', name: 'release-notes', origin: 'user', plugin: 'fde-user' }] })
      }
      if (String(input) === '/api/configuration/capabilities/toggle' && init?.method === 'POST') return response(catalog)
      return response({ title: 'Unexpected request' }, 500)
    }))
  })

  it('shows the complete inventory and filters sub-agents', async () => {
    render(<CapabilitiesView />)
    expect(await screen.findByText('Capabilities & extensions')).toBeInTheDocument()
    expect(screen.getByText('implementation')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Sub-agents/ }))
    expect(screen.getByText('reviewer')).toBeInTheDocument()
    expect(screen.queryByText('implementation')).toBeNull()
  })

  it('creates a custom skill with an explicit tool selection', async () => {
    render(<CapabilitiesView />)
    await screen.findByText('Capabilities & extensions')
    await userEvent.click(screen.getByRole('button', { name: 'Create skill' }))
    const form = screen.getByRole('heading', { name: 'Create a user skill' }).closest('form')
    expect(form).not.toBeNull()
    await userEvent.type(within(form!).getByLabelText('Skill name'), 'release-notes')
    await userEvent.type(within(form!).getByLabelText('When should it be used?'), 'Prepare verified release notes.')
    await userEvent.type(within(form!).getByLabelText('Instructions'), 'Summarise verified changes and migrations.')
    await userEvent.click(within(form!).getByRole('button', { name: 'Create skill' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/configuration/skills', expect.objectContaining({ method: 'POST' })))
  })

  it('switches a capability through the persisted configuration API', async () => {
    render(<CapabilitiesView />)
    await screen.findByText('Capabilities & extensions')
    await userEvent.click(screen.getByRole('switch', { name: 'Switch off implementation' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/configuration/capabilities/toggle',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: 'skill:fde-core:implementation', enabled: false }) })))
  })
})
