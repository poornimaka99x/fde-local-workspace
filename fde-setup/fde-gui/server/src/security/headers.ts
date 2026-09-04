import type { FastifyInstance } from 'fastify'

/**
 * One place for the response headers, applied to everything the server sends.
 *
 * The page may load its own scripts and styles and nothing else: no external
 * origin, no framing, no referrer, no store. File responses tighten this
 * further in the file route.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store')
    reply.header('pragma', 'no-cache')
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-frame-options', 'DENY')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('cross-origin-opener-policy', 'same-origin')
    reply.header('cross-origin-resource-policy', 'same-origin')
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()')
    if (!reply.hasHeader('content-security-policy')) {
      reply.header('content-security-policy', CSP)
    }
    return payload
  })
}
