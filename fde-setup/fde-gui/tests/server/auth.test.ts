import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authed, makeHarness, type Harness } from './harness'

describe('local API access control', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await makeHarness()
    harness.fixture('list', { schemaVersion: 1, runs: [], warnings: [] })
  })
  afterEach(async () => harness.destroy())

  it('refuses a request with no token', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/runs' })
    expect(response.statusCode).toBe(401)
    expect(response.headers['content-type']).toContain('application/problem+json')
    expect(response.json()).toMatchObject({ type: 'about:fde/unauthenticated', status: 401 })
    expect(harness.calls()).toHaveLength(0)
  })

  it('refuses a wrong token, whatever its length', async () => {
    for (const token of ['nope', 'test-token-not-a-real-onX', 'test-token-not-a-real-on']) {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/runs',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.statusCode).toBe(401)
    }
    expect(harness.calls()).toHaveLength(0)
  })

  it('accepts the launch token', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: authed(harness.token),
    })
    expect(response.statusCode).toBe(200)
  })

  it('refuses another origin even with the right token', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { ...authed(harness.token), origin: 'http://evil.example' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ type: 'about:fde/forbidden-origin' })
  })

  it('refuses a cross-site fetch even with the right token', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { authorization: `Bearer ${harness.token}`, 'sec-fetch-site': 'cross-site' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('sends the same hardening headers on every response', async () => {
    for (const url of ['/api/health', '/']) {
      const response = await harness.app.inject({ method: 'GET', url, headers: authed(harness.token) })
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['x-content-type-options']).toBe('nosniff')
      expect(response.headers['x-frame-options']).toBe('DENY')
      expect(response.headers['referrer-policy']).toBe('no-referrer')
      expect(String(response.headers['content-security-policy'])).toContain("frame-ancestors 'none'")
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    }
  })

  it('offers no route for deleting, approving, publishing or starting a session', async () => {
    const changes: [string, string][] = [
      ['DELETE', '/api/projects/returns-a1b2'],
      ['DELETE', '/api/runs/20260901-max-1-aaaa'],
      ['POST', '/api/runs/20260901-max-1-aaaa/approve'],
      ['POST', '/api/runs/20260901-max-1-aaaa/session/resume'],
      ['POST', '/api/runs/20260901-max-1-aaaa/publish'],
    ]
    for (const [method, url] of changes) {
      const response = await harness.app.inject({
        method: method as 'POST',
        url,
        headers: { ...authed(harness.token), origin: 'http://127.0.0.1:7317' },
      })
      expect([404, 405], `${method} ${url}`).toContain(response.statusCode)
    }
    expect(harness.calls()).toHaveLength(0)
  })

  it('answers an unknown API path with problem details, not HTML', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/nope',
      headers: authed(harness.token),
    })
    expect(response.statusCode).toBe(404)
    expect(response.headers['content-type']).toContain('application/problem+json')
  })

  it('never reports a credential or the token in health', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: authed(harness.token),
    })
    expect(response.statusCode).toBe(200)
    expect(response.payload).not.toContain(harness.token)
    expect(response.json()).toMatchObject({ mode: 'read-only' })
  })
})
