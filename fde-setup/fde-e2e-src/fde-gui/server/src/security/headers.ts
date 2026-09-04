import type { FastifyInstance } from 'fastify'
import type { GuiConfig } from '../config'

/**
 * One place for the response headers, applied to everything the server sends.
 *
 * The page may load its own scripts and styles and nothing else: no external
 * origin, no framing, no referrer, no store. File responses tighten this
 * further in the file route.
 */
function policyFor(config: GuiConfig): string {
  // The terminal stream is a WebSocket to this same server, named explicitly so
  // the policy stays readable and nothing else becomes connectable.
  const sockets = [
    `ws://${config.host}:${config.port}`,
    `ws://localhost:${config.port}`,
  ].join(' ')
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self' ${sockets}`,
    "frame-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ')
}

export function registerSecurityHeaders(app: FastifyInstance, config: GuiConfig): void {
  const CSP = policyFor(config)
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
