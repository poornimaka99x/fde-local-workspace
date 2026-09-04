import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { ZodError } from 'zod'
import type { GuiConfig } from './config'
import { problem } from './problem'
import { registerAuth } from './security/auth'
import { registerSecurityHeaders } from './security/headers'
import { registerHealthRoutes } from './routes/health'
import { registerProjectRoutes } from './routes/projects'
import { registerRunRoutes } from './routes/runs'
import { ControllerError } from './services/controller'
import { FilePathError } from './services/files'
import { AdvisoryLocks } from './services/locks'
import { ChangeWatcher } from './services/watch'
import type { Services } from './services/types'

const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

const MISSING_BUILD_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>FDE Control Center</title></head><body style="font:14px system-ui;padding:2rem">
<h1>The console has not been built yet</h1>
<p>Run <code>npm run build</code> in <code>fde-gui/</code>, then reload.</p>
</body></html>`

export function buildApp(config: GuiConfig, services?: Partial<Services>): FastifyInstance {
  const resolved: Services = {
    locks: services?.locks ?? new AdvisoryLocks(),
    watcher: services?.watcher ?? new ChangeWatcher(),
  }
  resolved.watcher.start([config.runsRoot, config.projectsRoot])
  const app = Fastify({
    logger: false,
    bodyLimit: config.bodyLimitBytes,
    trustProxy: false,
  })

  // An upload arrives as bytes, not as a parsed body: the stream is handed
  // straight to the controller's stdin.
  app.addContentTypeParser(
    'application/octet-stream',
    (_request, payload, done) => done(null, payload),
  )

  registerSecurityHeaders(app)
  registerAuth(app, config)
  registerHealthRoutes(app, config, resolved)
  registerProjectRoutes(app, config, resolved)
  registerRunRoutes(app, config, resolved)

  app.addHook('onClose', async () => resolved.watcher.stop())

  const sendIndex = async (reply: FastifyReply): Promise<unknown> => {
    const indexPath = path.join(config.webRoot, 'index.html')
    try {
      await stat(indexPath)
    } catch {
      return reply.type('text/html; charset=utf-8').send(MISSING_BUILD_PAGE)
    }
    return reply.type('text/html; charset=utf-8').send(createReadStream(indexPath))
  }

  app.get('/', async (_request, reply) => sendIndex(reply))

  // Built assets only: resolved inside the build directory, allowlisted by
  // extension, and never a directory listing.
  app.get<{ Params: { '*': string } }>('/assets/*', async (request, reply) => {
    const requested = request.params['*'] ?? ''
    if (requested === '' || requested.includes('\0') || requested.split('/').some((s) => s === '..')) {
      return problem(reply, 400, 'invalid-path', 'Invalid asset path.')
    }
    const root = path.resolve(config.webRoot, 'assets')
    const target = path.resolve(root, requested)
    if (!target.startsWith(root + path.sep)) {
      return problem(reply, 403, 'outside-root', 'That asset is outside the console build.')
    }
    const type = ASSET_TYPES[path.extname(target).toLowerCase()]
    if (type === undefined) {
      return problem(reply, 404, 'not-found', 'No such asset.')
    }
    try {
      const info = await stat(target)
      if (!info.isFile()) return problem(reply, 404, 'not-found', 'No such asset.')
      reply.header('content-type', type)
      reply.header('content-length', String(info.size))
      return reply.send(createReadStream(target))
    } catch {
      return problem(reply, 404, 'not-found', 'No such asset.')
    }
  })

  app.setNotFoundHandler(async (request, reply) => {
    if (request.method !== 'GET') {
      return problem(reply, 405, 'method-not-allowed', 'That is not something this console does.')
    }
    if (request.url.startsWith('/api/')) {
      return problem(reply, 404, 'not-found', 'No such endpoint.')
    }
    return sendIndex(reply)
  })

  app.setErrorHandler(async (error: unknown, _request, reply) => {
    if (error instanceof ControllerError) {
      return problem(reply, error.status, error.code, error.message, error.detail)
    }
    if (error instanceof FilePathError) {
      return problem(reply, error.status, error.code, error.message)
    }
    if (error instanceof ZodError) {
      return problem(
        reply,
        502,
        'controller-unexpected-shape',
        'The controller answered in a shape this console does not understand.',
        error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      )
    }
    const code = (error as { code?: unknown }).code
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return problem(reply, 413, 'attachment-too-large',
        'That upload is larger than this console accepts.')
    }
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return problem(reply, 400, 'invalid-body', 'That request body could not be read.')
    }
    const statusCode = (error as { statusCode?: unknown }).statusCode
    const status = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600 ? statusCode : 500
    // Deliberately no stack, no message from an unexpected exception.
    return problem(reply, status, 'internal-error', 'The console hit an unexpected error.')
  })

  return app
}
