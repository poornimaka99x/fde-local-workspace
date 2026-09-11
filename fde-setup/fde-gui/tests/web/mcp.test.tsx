// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { McpCatalogView } from '../../web/src/features/mcp/McpCatalogView'
import { NewChatForm } from '../../web/src/features/chats/NewChatForm'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })
}

const base = {
  enabled: true, transport: 'stdio', auth: 'none', targets: [], stages: [], profiles: [],
  package: null, missingDependencies: [], missingConfiguration: [], requiredFields: [],
  credentialsPresent: {}, enforceableTools: null, unscopedWrites: false,
  verification: {}, gateway: {}, useWhen: '', preferOver: [], doNotUseWhen: '',
  note: '', values: {},
}

const servers = [
  {
    ...base, name: 'context7', state: 'ready', reason: 'available, configured and verifiable',
    transport: 'http', classification: 'public-documentation', mutation: 'read-only',
    readOnlyPolicy: 'server-flag', profiles: ['coding'], package: null,
  },
  {
    ...base, name: 'serena', state: 'unavailable',
    reason: 'missing on this machine: serena. uv tool install -p 3.13 serena-agent',
    classification: 'repository-local', mutation: 'mutation-capable', readOnlyPolicy: 'patterns',
    profiles: ['coding'], missingDependencies: ['serena'], enforceableTools: [],
    setup: 'uv tool install -p 3.13 serena-agent', package: 'serena-agent@1.7.0',
  },
  {
    ...base, name: 'atlassian', state: 'ready',
    reason: "sign in inside its MCP client (/mcp); its tools cannot be scoped from here",
    transport: 'http', classification: 'tenant-data', mutation: 'mutation-capable',
    readOnlyPolicy: 'client-credential', profiles: ['client-delivery'], unscopedWrites: true,
    requiredFields: [{
      name: 'allowTools', label: 'Pin a read-only tool allowlist (comma separated)',
      required: false, secret: false, type: 'text', options: [],
    }],
  },
  {
    ...base, name: 'dbhub', state: 'not_configured',
    reason: 'not configured: Read-only PostgreSQL DSN',
    classification: 'customer-data', mutation: 'read-only', readOnlyPolicy: 'server-flag',
    profiles: ['data'], missingConfiguration: ['Read-only PostgreSQL DSN'],
    requiredFields: [
      { name: 'host', label: 'Host', required: true, secret: false, type: 'text', options: [] },
      { name: 'dsn', label: 'Read-only PostgreSQL DSN', required: true, secret: true, type: 'password', options: [] },
    ],
    credentialsPresent: { dsn: false },
  },
]

const catalogue = {
  schemaVersion: 2,
  catalogue: { path: '/tmp/mcp-servers.json', valid: true, problems: [], schemaVersionOnDisk: 2 },
  profiles: [
    { name: 'coding', label: 'Coding', description: 'Repository work.', servers: ['context7', 'serena'], docker: 'coding' },
    { name: 'data', label: 'Data', description: 'Bounded reads.', servers: ['dbhub'], docker: 'data' },
  ],
  servers,
}

const gateway = {
  schemaVersion: 2, available: false, detail: 'docker is not installed', profile: null,
  routedThroughGateway: {}, runDirectly: ['context7'], dockerProfiles: [],
  note: 'Docker is optional.',
}

describe('the MCP catalogue panel', () => {
  let sent: Array<{ url: string, method: string, body: unknown }>

  beforeEach(() => {
    sent = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      sent.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
      if (url === '/api/mcp/servers') return response(catalogue)
      if (url === '/api/mcp/gateway') return response(gateway)
      if (url.includes('/verify')) return response({ schemaVersion: 2, server: servers[0] })
      if (url.includes('/configure')) return response({ schemaVersion: 2, server: servers[3] })
      return response({ title: 'unexpected request' }, 500)
    }))
  })

  it('separates what FLOW knows about from what a run could actually use', async () => {
    render(<McpCatalogView />)
    await waitFor(() => expect(screen.getByText('MCP servers')).toBeInTheDocument())
    expect(screen.getAllByText('ready', { selector: '.badge' })).toHaveLength(2)
    expect(screen.getByText('unavailable')).toBeInTheDocument()
    expect(screen.getByText('not configured')).toBeInTheDocument()
  })

  it('names the exact setup command rather than offering to install anything', async () => {
    render(<McpCatalogView />)
    await waitFor(() => expect(screen.getByText('uv tool install -p 3.13 serena-agent'))
      .toBeInTheDocument())
    expect(screen.getByText(/will not install it for you/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull()
  })

  it('says plainly when a provider reaches a session with its write tools intact', async () => {
    render(<McpCatalogView />)
    await waitFor(() => expect(screen.getByText(/cannot scope this provider/i)).toBeInTheDocument())
    expect(screen.getByText('Unscoped — write tools reach the session')).toBeInTheDocument()
    expect(screen.getByText(/approve-publish/)).toBeInTheDocument()
  })

  it('starts nothing until verification is asked for', async () => {
    render(<McpCatalogView />)
    await waitFor(() => expect(screen.getByText('MCP servers')).toBeInTheDocument())
    expect(sent.every((call) => call.method === 'GET')).toBe(true)
    const [verify] = screen.getAllByRole('button', { name: 'Verify' })
    expect(verify).toBeDefined()
    await userEvent.click(verify as HTMLElement)
    await waitFor(() => expect(sent.some((call) => call.url.endsWith('/verify'))).toBe(true))
  })

  it('shows Docker as optional rather than as a missing dependency', async () => {
    render(<McpCatalogView />)
    await waitFor(() => expect(screen.getByText(/Docker is optional/)).toBeInTheDocument())
    expect(screen.getByText(/not installed/)).toBeInTheDocument()
  })

  it('offers only the credential the chosen connection mode actually uses', async () => {
    // DBHub takes either a whole DSN or a password, never both. Showing both
    // would leave the operator guessing which one the server will read.
    const dbhub = {
      ...base, name: 'dbhub', state: 'not_configured',
      reason: 'not configured: Read-only PostgreSQL DSN',
      classification: 'customer-data', mutation: 'read-only', readOnlyPolicy: 'server-flag',
      profiles: ['data'], missingConfiguration: ['Read-only PostgreSQL DSN'],
      values: { connectionMode: 'dsn' },
      requiredFields: [
        { name: 'connectionMode', label: 'Connection', required: true, secret: false,
          type: 'select', options: [{ value: 'dsn', label: 'A single read-only DSN' },
            { value: 'parts', label: 'Separate host / port / database / user' }] },
        { name: 'dsn', label: 'Read-only PostgreSQL DSN', required: true, secret: true,
          type: 'password', options: [], showWhen: { field: 'connectionMode', equals: 'dsn' } },
        { name: 'host', label: 'Host', required: true, secret: false, type: 'text',
          options: [], showWhen: { field: 'connectionMode', equals: 'parts' } },
        { name: 'password', label: 'Read-only account password', required: true, secret: true,
          type: 'password', options: [], showWhen: { field: 'connectionMode', equals: 'parts' } },
      ],
      credentialsPresent: { dsn: false, password: false },
    }
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = String(input)
      if (url === '/api/mcp/servers') return response({ ...catalogue, servers: [dbhub] })
      if (url === '/api/mcp/gateway') return response(gateway)
      return response({ title: 'unexpected request' }, 500)
    }))
    render(<McpCatalogView />)
    // The form is already open, because this server is waiting on the operator.
    await waitFor(() => expect(screen.getByText('Read-only PostgreSQL DSN')).toBeInTheDocument())
    expect(screen.getByText(/Waiting on you/)).toBeInTheDocument()
    expect(screen.queryByText('Read-only account password')).toBeNull()
    expect(screen.queryByText('Host')).toBeNull()

    await userEvent.selectOptions(screen.getByLabelText('Connection'), 'parts')
    await waitFor(() => expect(screen.getByText('Read-only account password')).toBeInTheDocument())
    expect(screen.getByText('Host')).toBeInTheDocument()
    expect(screen.queryByText('Read-only PostgreSQL DSN')).toBeNull()
  })

  it('narrows to a profile without inventing access', async () => {
    render(<McpCatalogView />)
    await waitFor(() => expect(screen.getByText('MCP servers')).toBeInTheDocument())
    await userEvent.selectOptions(screen.getByLabelText('Profile'), 'data')
    await waitFor(() => expect(screen.queryByText('serena')).toBeNull())
    expect(screen.getByText('dbhub')).toBeInTheDocument()
  })
})

describe('service access in a new chat', () => {
  const connection = (over: Record<string, unknown>) => ({
    id: 'custom-mcp-knowledge', name: 'Knowledge', provider: 'custom-mcp',
    providerLabel: 'Custom MCP server', fields: {}, configured: true, status: 'configured',
    oauth: false, authMethod: 'bearer', verifiedTools: null, readOnly: null, ...over,
  })

  const stub = (connections: unknown[]): void => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = String(input)
      if (url === '/api/projects') return response({ schemaVersion: 1, projects: [] })
      if (url === '/api/connections') return response({ schemaVersion: 1, connections })
      if (url.startsWith('/api/claude/accounts')) return response({ schemaVersion: 1, accounts: [] })
      return response({ schemaVersion: 1, accounts: [], connections: [], projects: [] })
    }))
  }

  it('will not offer a connection whose tools it has never listed', async () => {
    stub([connection({})])
    render(<NewChatForm />)
    await waitFor(() => expect(screen.getByText(/Not offered yet/)).toBeInTheDocument())
    expect(screen.getByText(/cannot be described as read-only/i)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Knowledge/ })).toBeNull()
  })

  it('distinguishes a verified read-only connection from one that can change things', async () => {
    stub([
      connection({ id: 'a', name: 'Docs', verifiedTools: 4, readOnly: true }),
      connection({ id: 'b', name: 'Writer', verifiedTools: 6, readOnly: false }),
    ])
    render(<NewChatForm />)
    await waitFor(() => expect(screen.getByText('Docs')).toBeInTheDocument())
    expect(screen.getByText(/read-only/)).toBeInTheDocument()
    expect(screen.getByText(/has tools that can change things/)).toBeInTheDocument()
    expect(screen.queryByText(/Not offered yet/)).toBeNull()
  })
})
