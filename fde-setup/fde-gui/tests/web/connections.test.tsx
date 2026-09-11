// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionsView } from '../../web/src/features/accounts/ConnectionsView'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const providers = [
  {
    provider: 'atlassian', label: 'Atlassian Cloud', secretLabel: 'API token',
    docsUrl: 'https://example.test/atlassian', note: 'Jira and Confluence REST access.',
    oauth: false,
    fields: [
      { name: 'siteUrl', label: 'Site URL', required: true, placeholder: 'https://company.atlassian.net' },
      { name: 'email', label: 'Account email', required: true, placeholder: 'you@example.com' },
    ],
  },
  {
    provider: 'github', label: 'GitHub', secretLabel: 'Personal access token',
    docsUrl: 'https://example.test/github', note: 'Use a least-privilege token.', oauth: false, fields: [],
  },
  {
    provider: 'figma', label: 'Figma', secretLabel: null,
    docsUrl: 'https://example.test/figma', note: 'OAuth stays in the MCP client.', oauth: true, fields: [],
  },
  {
    provider: 'custom-mcp', label: 'Custom MCP server', secretLabel: 'Credential',
    docsUrl: 'https://modelcontextprotocol.io', note: 'Connect a remote MCP server.', oauth: false,
    fields: [
      { name: 'url', label: 'MCP URL', required: true, type: 'url' },
      { name: 'authMethod', label: 'Authentication', required: true, type: 'select', defaultValue: 'oauth',
        options: [{ value: 'oauth', label: 'OAuth 2.1' }, { value: 'header', label: 'API key / custom header' }] },
      { name: 'headerName', label: 'Header name', required: true, showWhen: { field: 'authMethod', equals: 'header' } },
    ],
  },
]

describe('service connections panel', () => {
  let connections: Array<Record<string, unknown>>
  let sent: Array<{ url: string; method: string; body: unknown }>

  beforeEach(() => {
    connections = []
    sent = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      sent.push({ url, method, body })
      if (url === '/api/connections/providers') return response({ schemaVersion: 1, providers })
      if (url === '/api/connections' && method === 'GET') {
        return response({ schemaVersion: 1, connections })
      }
      if (url === '/api/connections' && method === 'POST') {
        const request = body as { provider: string; name: string; fields: Record<string, string> }
        const created = {
          id: `${request.provider}-work`, name: request.name, provider: request.provider,
          providerLabel: providers.find((item) => item.provider === request.provider)?.label,
          fields: request.fields, configured: request.provider === 'figma',
          status: request.provider === 'figma' ? 'oauth_required' : 'not_configured',
          oauth: request.provider === 'figma',
        }
        connections = [...connections, created]
        return response({ schemaVersion: 1, connection: created }, 201)
      }
      if (url.endsWith('/secret')) {
        const current = { ...connections[0], configured: true, status: 'configured' }
        connections = [current]
        return response({ schemaVersion: 1, connection: current })
      }
      return response({ title: 'unexpected request' }, 500)
    }))
  })

  afterEach(() => vi.unstubAllGlobals())

  it('collects only the metadata required by the selected provider', async () => {
    render(<ConnectionsView />)
    await screen.findByRole('heading', { name: 'Add a connection' })
    await userEvent.type(screen.getByLabelText('Connection name'), 'Work')
    await userEvent.type(screen.getByLabelText('Site URL'), 'https://company.atlassian.net')
    await userEvent.type(screen.getByLabelText('Account email'), 'me@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Add connection' }))
    await waitFor(() => expect(sent.some((item) => item.method === 'POST')).toBe(true))
    expect(sent.find((item) => item.method === 'POST')?.body).toEqual({
      provider: 'atlassian', name: 'Work',
      fields: { siteUrl: 'https://company.atlassian.net', email: 'me@example.com' },
    })
  })

  it('submits a token once and never renders it back into the card', async () => {
    connections = [{
      id: 'github-work', name: 'Work', provider: 'github', providerLabel: 'GitHub',
      fields: {}, configured: false, status: 'not_configured', oauth: false,
    }]
    render(<ConnectionsView />)
    const card = (await screen.findByRole('heading', { name: 'Work' })).closest('article') as HTMLElement
    const token = 'github-token-that-must-not-return'
    await userEvent.type(within(card).getByLabelText('Personal access token'), token)
    await userEvent.click(within(card).getByRole('button', { name: 'Store securely' }))
    await waitFor(() => expect(sent.some((item) => item.url.endsWith('/secret'))).toBe(true))
    expect(sent.find((item) => item.url.endsWith('/secret'))?.body).toEqual({ secret: token })
    expect(card).not.toHaveTextContent(token)
    expect(within(card).getByLabelText(/token/i)).toHaveValue('')
  })

  it('asks only for details required by the selected MCP authentication method', async () => {
    render(<ConnectionsView />)
    await userEvent.selectOptions(await screen.findByLabelText('Provider'), 'custom-mcp')
    expect(screen.getByLabelText('MCP URL')).toBeInTheDocument()
    expect(screen.queryByLabelText('Header name')).toBeNull()
    await userEvent.selectOptions(screen.getByLabelText('Authentication'), 'header')
    expect(screen.getByLabelText('Header name')).toBeInTheDocument()
  })

  it('explains that Figma OAuth belongs to the run-scoped MCP client', async () => {
    connections = [{
      id: 'figma-work', name: 'Design team', provider: 'figma', providerLabel: 'Figma',
      fields: {}, configured: true, status: 'oauth_required', oauth: true,
    }]
    render(<ConnectionsView />)
    const card = (await screen.findByRole('heading', { name: 'Design team' })).closest('article') as HTMLElement
    expect(within(card).getByText(/OAuth in the assigned MCP client/)).toBeInTheDocument()
    expect(within(card).queryByRole('textbox')).toBeNull()
  })

  it('shows connection metadata returned by the existing shared inventory', async () => {
    connections = [{
      id: 'atlassian-acme', name: 'Acme', provider: 'atlassian',
      providerLabel: 'Atlassian Cloud',
      fields: { siteUrl: 'https://example.atlassian.net', email: 'user@example.test' },
      configured: true, status: 'configured', oauth: false,
    }]
    render(<ConnectionsView />)

    const card = (await screen.findByRole('heading', { name: 'Acme' })).closest('article') as HTMLElement
    expect(within(card).getByText('https://example.atlassian.net')).toBeInTheDocument()
    expect(screen.queryByText('No service connections')).toBeNull()
  })
})
