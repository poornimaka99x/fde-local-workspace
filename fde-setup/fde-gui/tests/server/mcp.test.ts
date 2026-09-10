import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authed, makeHarness, type Harness } from './harness'

/**
 * The console's MCP endpoints. Every answer comes from the controller, so what
 * these prove is that the console asks the right question, passes a credential
 * only on stdin, and never invents a friendlier answer than the one it got.
 */
const headers = (token: string) => ({
  ...authed(token), origin: 'http://127.0.0.1:7317', 'content-type': 'application/json',
})

const server = (over: Record<string, unknown> = {}) => ({
  name: 'dbhub', state: 'not_configured',
  reason: 'not configured: Read-only PostgreSQL DSN',
  enabled: true, transport: 'stdio', auth: 'none', classification: 'customer-data',
  mutation: 'read-only', readOnlyPolicy: 'server-flag',
  targets: ['role:research'], stages: ['research'], profiles: ['data'],
  package: '@bytebase/dbhub@1.2.3',
  missingDependencies: [], missingConfiguration: ['Read-only PostgreSQL DSN'],
  requiredFields: [
    { name: 'host', label: 'Host', required: true, secret: false, type: 'text', options: [] },
    { name: 'dsn', label: 'Read-only PostgreSQL DSN', required: true, secret: true, type: 'password', options: [] },
  ],
  credentialsPresent: { dsn: false },
  enforceableTools: null, unscopedWrites: false,
  verification: { at: null, initialize: null, toolCount: null, outcome: null, detail: null },
  gateway: { docker: 'data' }, useWhen: 'Schema discovery.', preferOver: [],
  doNotUseWhen: 'Anything outside the data profile.', setup: null, docsUrl: null,
  note: 'PostgreSQL only.', values: { port: '5432' },
  ...over,
})

const listing = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  catalogue: { path: '/tmp/mcp-servers.json', valid: true, problems: [], schemaVersionOnDisk: 2 },
  profiles: [{ name: 'data', label: 'Data', description: 'Bounded reads.', servers: ['dbhub'], docker: 'data' }],
  servers: [server()],
  ...over,
})

describe('the MCP catalogue', () => {
  let h: Harness
  beforeEach(async () => {
    h = await makeHarness()
    h.fixture('mcp-list', listing())
    h.fixture('mcp-status-dbhub', { schemaVersion: 2, server: server() })
    h.fixture('mcp-configure-dbhub', { schemaVersion: 2, server: server({ values: { host: 'db.internal' } }) })
    h.fixture('mcp-set-secret-dbhub-dsn', {
      schemaVersion: 2, server: server({ state: 'ready', credentialsPresent: { dsn: true } }),
    })
    h.fixture('mcp-verify-dbhub', {
      schemaVersion: 2,
      server: server({
        state: 'ready', reason: 'available, configured and verifiable',
        verification: { at: '2026-09-10T00:00:00Z', initialize: 200, toolCount: 6, outcome: 'ok', detail: null },
      }),
    })
    h.fixture('mcp-enable-dbhub', { schemaVersion: 2, server: server({ enabled: true }) })
    h.fixture('mcp-effective', {
      schemaVersion: 2, runId: null, profile: 'data', roles: ['research'], stages: ['research'],
      active: [{ name: 'context7', mutation: 'read-only', classification: 'public-documentation', allowedTools: null, identities: [] }],
      refused: [{ name: 'dbhub', state: 'not_configured', reason: 'not configured: Read-only PostgreSQL DSN' }],
    })
    h.fixture('mcp-gateway', {
      schemaVersion: 2, available: false, detail: 'docker is not installed', profile: null,
      routedThroughGateway: {}, runDirectly: ['dbhub'], dockerProfiles: [], note: 'Docker is optional.',
    })
  })
  afterEach(async () => h.destroy())

  it('reads the catalogue through the controller and starts nothing', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/mcp/servers', headers: authed(h.token) })
    expect(response.statusCode).toBe(200)
    expect(response.json().servers[0]).toMatchObject({ name: 'dbhub', state: 'not_configured' })
    expect(h.calls()).toContainEqual(['mcp', 'list', '--json'])
    // Opening the page must never imply a verification, which is the only call
    // that would launch a server or fetch a package.
    expect(JSON.stringify(h.calls())).not.toContain('verify')
  })

  it('sends settings as named pairs and refuses anything the schema does not allow', async () => {
    const ok = await h.app.inject({
      method: 'POST', url: '/api/mcp/servers/dbhub/configure', headers: headers(h.token),
      payload: { values: { host: 'db.internal', database: 'orders' } },
    })
    expect(ok.statusCode).toBe(200)
    expect(h.calls()).toContainEqual([
      'mcp', 'configure', 'dbhub', '--set', 'host=db.internal', '--set', 'database=orders', '--json',
    ])
    const bad = await h.app.inject({
      method: 'POST', url: '/api/mcp/servers/Not A Server/configure', headers: headers(h.token),
      payload: { values: {} },
    })
    expect(bad.statusCode).toBe(400)
  })

  it('passes a credential on stdin, never in argv, and never returns it', async () => {
    const response = await h.app.inject({
      method: 'POST', url: '/api/mcp/servers/dbhub/secret/dsn', headers: headers(h.token),
      payload: { secret: 'postgres://readonly@db.internal:5432/orders' },
    })
    expect(response.statusCode).toBe(200)
    expect(h.calls()).toContainEqual(['mcp', 'set-secret', 'dbhub', 'dsn', '--json'])
    expect(JSON.stringify(h.calls())).not.toContain('postgres://')
    expect(JSON.stringify(response.json())).not.toContain('postgres://')
    expect(response.json().server.credentialsPresent.dsn).toBe(true)
    expect(h.stdinFor('mcp-set-secret-dbhub-dsn')?.toString()).toContain('postgres://readonly@')
  })

  it('verifies only when asked, and reports what the server answered', async () => {
    const response = await h.app.inject({
      method: 'POST', url: '/api/mcp/servers/dbhub/verify', headers: headers(h.token), payload: {},
    })
    expect(response.statusCode).toBe(200)
    expect(h.calls()).toContainEqual(['mcp', 'verify', 'dbhub', '--json'])
    expect(response.json().server.verification).toMatchObject({ initialize: 200, toolCount: 6 })
    expect(response.json().server.state).toBe('ready')
  })

  it('reports the effective set with the refusals that explain it', async () => {
    const response = await h.app.inject({
      method: 'GET', url: '/api/mcp/effective?profile=data&role=research&stage=research',
      headers: authed(h.token),
    })
    expect(response.statusCode).toBe(200)
    expect(h.calls()).toContainEqual([
      'mcp', 'effective', '--profile', 'data', '--role', 'research', '--stage', 'research', '--json',
    ])
    expect(response.json().refused[0]).toMatchObject({ name: 'dbhub', state: 'not_configured' })
  })

  it('shows the Docker gateway as optional rather than missing', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/mcp/gateway', headers: authed(h.token) })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ available: false, routedThroughGateway: {} })
  })

  it('passes an invalid catalogue through instead of pretending it is fine', async () => {
    h.fixture('mcp-list', listing({
      catalogue: {
        path: '/tmp/mcp-servers.json', valid: false, schemaVersionOnDisk: 2,
        problems: ["server 'x': unknown target 'copilot'"],
      },
      servers: [],
    }))
    const response = await h.app.inject({ method: 'GET', url: '/api/mcp/servers', headers: authed(h.token) })
    expect(response.statusCode).toBe(200)
    expect(response.json().catalogue.valid).toBe(false)
    expect(response.json().catalogue.problems[0]).toContain('unknown target')
  })

  it('requires the mutating-request headers like every other change', async () => {
    const response = await h.app.inject({
      method: 'POST', url: '/api/mcp/servers/dbhub/verify', headers: authed(h.token), payload: {},
    })
    expect(response.statusCode).toBe(403)
    expect(h.calls().some((call) => call[0] === 'mcp' && call[1] === 'verify')).toBe(false)
  })
})
