/**
 * Every websocket terminal this console serves, in one table.
 *
 * A browser cannot put an Authorization header on a WebSocket, so these
 * upgrades authenticate with a single-use ticket in the query string instead
 * of the bearer token. Which URLs get that treatment used to be two regexes
 * maintained by hand inside the auth hook, copied from the route table — and
 * they drifted. The Accounts screen's sign-in terminal matched neither, fell
 * through to the bearer branch where a browser has no way to present a token,
 * and refused every upgrade: interactive sign-in was impossible for every
 * account whose loginMode is `terminal`.
 *
 * The table is now the single source of truth. `path` is the Fastify path
 * string exactly as the route registers it, and `buildApp` asserts at launch
 * that every route it registers with `websocket: true` appears here. A new
 * terminal route that is not listed fails the console's own startup instead
 * of silently refusing the operator.
 */

/** One websocket terminal: its route path, and the session key it belongs to. */
export interface TerminalRoute {
  /** The Fastify path, character for character as the route registers it. */
  path: string
  /** The session key this terminal's ticket must have been issued against. */
  key: (params: string[]) => string
}

export const TERMINAL_ROUTES: readonly TerminalRoute[] = [
  {
    path: '/api/runs/:runId/session/terminal',
    key: ([runId]) => runId ?? '',
  },
  {
    // The chat-accounts screen, keyed by Claude profile.
    path: '/api/claude/accounts/:accountId/login/terminal',
    key: ([accountId]) => `login:${accountId ?? ''}`,
  },
  {
    // The AI-accounts screen, keyed by registry identity. These two keys are
    // deliberately different — see loginKeysFor in routes/terminal.ts.
    path: '/api/accounts/:accountId/login/terminal',
    key: ([accountId]) => `account-login:${accountId ?? ''}`,
  },
]

const ESCAPE = /[.*+?^${}()|[\]\\]/g

/**
 * The path string compiled to a matcher. Every `:param` segment becomes one
 * capture group; everything else is matched literally, so a path cannot be
 * widened by a metacharacter that happens to appear in it. A trailing
 * optional group captures the query string.
 */
function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? '([^/?]+)' : segment.replace(ESCAPE, '\\$&'),
    )
    .join('/')
  return new RegExp(`^${source}(?:\\?(.*))?$`)
}

const COMPILED = TERMINAL_ROUTES.map((route) => ({ ...route, pattern: compile(route.path) }))

/** Whether this Fastify path is a declared terminal route. */
export function isTerminalRoute(path: string): boolean {
  return TERMINAL_ROUTES.some((route) => route.path === path)
}

/**
 * The session key and query string for a terminal upgrade URL, or null when
 * the URL is not a terminal at all — in which case the caller must fall back
 * to the bearer token, as it does for every other request.
 */
export function terminalTarget(url: string): { key: string; query: string } | null {
  for (const route of COMPILED) {
    const match = route.pattern.exec(url)
    if (match === null) continue
    const groups = match.slice(1)
    const query = groups.pop() ?? ''
    let params: string[]
    try {
      params = groups.map((group) => decodeURIComponent(group ?? ''))
    } catch {
      // A malformed percent-escape is not a terminal we can identify.
      return null
    }
    if (params.some((param) => param === '')) return null
    return { key: route.key(params), query }
  }
  return null
}
