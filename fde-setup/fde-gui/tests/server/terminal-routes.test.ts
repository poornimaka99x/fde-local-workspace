import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import {
  TERMINAL_ROUTES,
  isTerminalRoute,
  terminalTarget,
} from '../../server/src/security/terminal-routes'
import { buildApp } from '../../server/src/app'
import { makeHarness } from './harness'

/**
 * These exist because the auth hook once carried its own hand-written copy of
 * the terminal route list and fell out of step with the routes: the Accounts
 * sign-in terminal matched neither pattern, so it authenticated by bearer
 * token, which a browser cannot send on a WebSocket. Every interactive
 * sign-in refused, on one screen only, with nothing in the log.
 */
describe('terminal route table', () => {
  it('recognises every sign-in and session terminal the UI opens', () => {
    expect(terminalTarget('/api/runs/20260904-acme-142-c6e6/session/terminal?ticket=t'))
      .toEqual({ key: '20260904-acme-142-c6e6', query: 'ticket=t' })

    // The chat-accounts screen (components/ClaudeLoginPanel.tsx).
    expect(terminalTarget('/api/claude/accounts/work/login/terminal?ticket=t'))
      .toEqual({ key: 'login:work', query: 'ticket=t' })

    // The AI-accounts screen (features/accounts/AccountLoginPanel.tsx) — the
    // one that was unreachable. Note the key differs from the line above.
    for (const id of ['claude_msc', 'claude_alt', 'claude_work']) {
      expect(terminalTarget(`/api/accounts/${id}/login/terminal?ticket=t`))
        .toEqual({ key: `account-login:${id}`, query: 'ticket=t' })
    }
  })

  it('does not treat an ordinary API path as a ticket-authenticated terminal', () => {
    for (const url of [
      '/api/runs',
      '/api/accounts/claude_msc/login',
      '/api/accounts/claude_msc/login/stop',
      '/api/accounts//login/terminal',
      '/api/accounts/claude_msc/login/terminal/extra',
      '/api/evil/accounts/claude_msc/login/terminal?ticket=t',
    ]) {
      expect(terminalTarget(url), url).toBeNull()
    }
  })

  it('percent-decodes the key and survives a malformed escape', () => {
    expect(terminalTarget('/api/accounts/a%20b/login/terminal?ticket=t')?.key)
      .toBe('account-login:a b')
    expect(terminalTarget('/api/accounts/%ZZ/login/terminal?ticket=t')).toBeNull()
  })

  it('matches a terminal with no query string at all', () => {
    expect(terminalTarget('/api/accounts/claude_msc/login/terminal'))
      .toEqual({ key: 'account-login:claude_msc', query: '' })
  })

  it('refuses to start when a websocket route is missing from the table', async () => {
    const app = Fastify()
    app.addHook('onRoute', (route) => {
      if (route.websocket !== true) return
      if (!isTerminalRoute(route.path)) throw new Error('unlisted')
    })
    expect(() => {
      app.get('/api/accounts/:accountId/login/socket', { websocket: true }, () => undefined)
    }).toThrow('unlisted')
    await app.close()
  })
})

describe('the console at launch', () => {
  it('registers no websocket route that the auth hook would refuse', async () => {
    // buildApp throws from its own onRoute guard if a terminal is unlisted,
    // so a clean build IS the assertion.
    const harness = await makeHarness()
    try {
      expect(harness.app).toBeDefined()
      for (const route of TERMINAL_ROUTES) {
        expect(isTerminalRoute(route.path)).toBe(true)
      }
    } finally {
      await harness.destroy()
    }
  })
})

// Referenced so an unused import cannot hide a broken build path.
void buildApp
