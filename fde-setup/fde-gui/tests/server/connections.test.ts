import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authed, makeHarness, type Harness } from './harness'

const provider = { provider: 'github', label: 'GitHub', secretLabel: 'Personal access token',
  docsUrl: 'https://github.com/settings/tokens', fields: [], note: 'GitHub.', oauth: false }
const connection = { id: 'github-work', name: 'Work', provider: 'github', providerLabel: 'GitHub',
  fields: {}, configured: true, status: 'configured', verifiedIdentity: null, verifiedAt: null,
  detail: null, oauth: false }
const headers = (token: string) => ({ ...authed(token), origin: 'http://127.0.0.1:7317', 'content-type': 'application/json' })

describe('service connections', () => {
  let h: Harness
  beforeEach(async () => {
    h = await makeHarness()
    h.fixture('connections-providers', { schemaVersion: 1, providers: [provider] })
    h.fixture('connections-list', { schemaVersion: 1, connections: [connection] })
    h.fixture('connections-add', { schemaVersion: 1, connection })
    h.fixture('connections-set-secret-github-work', { schemaVersion: 1, connection })
    h.fixture('connections-verify-github-work', { schemaVersion: 1, connection: { ...connection, status: 'connected', verifiedIdentity: 'octocat' } })
    h.fixture('connections-remove-github-work', { schemaVersion: 1, removed: connection })
  })
  afterEach(async () => h.destroy())

  it('delegates metadata to the controller', async () => {
    const response = await h.app.inject({ method: 'POST', url: '/api/connections', headers: headers(h.token),
      payload: { provider: 'github', name: 'Work', fields: {} } })
    expect(response.statusCode).toBe(201)
    expect(h.calls()).toContainEqual(['connections', 'add', '--provider', 'github', '--name', 'Work', '--json'])
  })

  it('passes a token on stdin and never argv or response', async () => {
    const secret = 'ghp_unmistakable_secret_value'
    const response = await h.app.inject({ method: 'POST', url: '/api/connections/github-work/secret',
      headers: headers(h.token), payload: { secret } })
    expect(response.statusCode).toBe(200)
    expect(h.stdinFor('connections-set-secret-github-work')?.toString()).toBe(secret)
    expect(JSON.stringify(h.calls())).not.toContain(secret)
    expect(response.body).not.toContain(secret)
  })

  it('verifies and removes through bounded controller commands', async () => {
    expect((await h.app.inject({ method: 'POST', url: '/api/connections/github-work/verify', headers: headers(h.token) })).statusCode).toBe(200)
    expect((await h.app.inject({ method: 'DELETE', url: '/api/connections/github-work', headers: headers(h.token) })).statusCode).toBe(200)
  })

  it('requires local authentication', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/api/connections' })).statusCode).toBe(401)
  })
})
