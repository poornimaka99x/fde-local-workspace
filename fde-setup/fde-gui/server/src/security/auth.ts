import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { GuiConfig } from '../config'
import { problem } from '../problem'

/**
 * Two independent checks on every request that reaches the API.
 *
 * 1. An unguessable per-launch token, presented as a bearer header. It is
 *    handed to the page in the URL fragment, which browsers never send to a
 *    server, so it stays out of logs, out of Referer and out of history sync.
 * 2. Origin and Sec-Fetch-Site, so a page on another origin cannot drive this
 *    server from the operator's browser even if it somehow learned the token.
 *
 * A mutation must additionally *present* an Origin. A same-origin fetch always
 * sends one on POST and PATCH, so requiring it costs the console nothing and
 * removes the one shape of cross-site request that arrives without it.
 *
 * There is no CORS. Nothing but the local UI is allowed to talk to this API.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function presentedToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim()
  }
  const direct = request.headers['x-fde-token']
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim()
  return null
}

export function registerAuth(app: FastifyInstance, config: GuiConfig): void {
  const expectedOrigins = new Set([
    `http://${config.host}:${config.port}`,
    `http://localhost:${config.port}`,
    // The Vite dev server, used only while working on the UI itself.
    'http://127.0.0.1:5199',
    'http://localhost:5199',
  ])

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/api/')) return

    // The token first, so a caller with no credential is told that plainly,
    // and the origin checks second, so a stolen token still cannot be spent
    // from another page.
    const token = presentedToken(request)
    if (token === null || !tokenMatches(token, config.token)) {
      reply.header('www-authenticate', 'Bearer realm="fde-control-center"')
      return problem(reply, 401, 'unauthenticated', 'A valid per-launch session token is required.')
    }

    const origin = request.headers.origin
    if (typeof origin === 'string' && origin !== '' && !expectedOrigins.has(origin)) {
      return problem(reply, 403, 'forbidden-origin', 'This API accepts requests from the local console only.')
    }
    const site = request.headers['sec-fetch-site']
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      return problem(reply, 403, 'forbidden-origin', 'This API accepts same-origin requests only.')
    }
    const mutating = request.method !== 'GET' && request.method !== 'HEAD'
    if (mutating && (typeof origin !== 'string' || origin === '')) {
      return problem(
        reply,
        403,
        'forbidden-origin',
        'A change must come from the local console, which always states its origin.',
      )
    }
    return undefined
  })
}
