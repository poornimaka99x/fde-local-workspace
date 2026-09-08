import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import websocket from '@fastify/websocket'
import { ZodError } from 'zod'
import type { GuiConfig } from './config'
import { problem } from './problem'
import { registerAuth } from './security/auth'
import { registerSecurityHeaders } from './security/headers'
import { registerHealthRoutes } from './routes/health'
import { registerFsRoutes } from './routes/fs'
import { registerProjectRoutes } from './routes/projects'
import { registerRunRoutes } from './routes/runs'
import { registerRoutingRoutes } from './routes/routing'
import { registerDesignPanelRoutes } from './routes/design-panel'
import { ControllerError } from './services/controller'
import { FilePathError } from './services/files'
import { AdvisoryLocks } from './services/locks'
import { SessionManager } from './services/sessions'
import { ChangeWatcher } from './services/watch'
import type { Services } from './services/types'
import { registerSessionRoutes } from './routes/sessions'
import { registerClaudeRoutes } from './routes/claude'
import { registerAccountRoutes } from './routes/accounts'
import { registerConnectionRoutes } from './routes/connections'
import { AccountService } from './services/accounts'
import { ChatService } from './services/chats'
import { DesignPanelService } from './services/design-panel'

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
  const accounts = services?.accounts ?? new AccountService(config)
  const watcher = services?.watcher ?? new ChangeWatcher()
  const resolved: Services = {
    locks: services?.locks ?? new AdvisoryLocks(),
    watcher,
    // No backend unless one is supplied: an installation without node-pty says
    // so rather than pretending it can open a terminal.
    sessions: services?.sessions ?? new SessionManager(null),
    accounts,
    chats: services?.chats ?? new ChatService(config, accounts),
    designPanels: services?.designPanels ?? new DesignPanelService(config, accounts, watcher),
  }
  resolved.watcher.start([config.runsRoot, config.projectsRoot])
  const app = Fastify({
    logger: false,
    bodyLimit: config.bodyLimitBytes,
    trustProxy: false,
    // A local console must be able to stop. A refused upgrade or a held-open
    // connection does not get to keep the process alive.
    forceCloseConnections: true,
  })

  // An upload arrives as bytes, not as a parsed body: the stream is handed
  // straight to the controller's stdin.
  app.addContentTypeParser(
    'application/octet-stream',
    (_request, payload, done) => done(null, payload),
  )

  // Some changes carry no body — resuming a session, for one. An empty body is
  // an empty object, not a parse error.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      const text = String(body ?? '').trim()
      if (text === '') {
        done(null, {})
        return
      }
      try {
        done(null, JSON.parse(text))
      } catch {
        done(Object.assign(new Error('invalid json'), { statusCode: 400 }), undefined)
      }
    },
  )

  registerSecurityHeaders(app, config)
  registerAuth(app, config, resolved)
  registerHealthRoutes(app, config, resolved)
  registerFsRoutes(app, config)
  registerProjectRoutes(app, config, resolved)
  registerRunRoutes(app, config, resolved)
  registerRoutingRoutes(app, config, resolved)
  registerDesignPanelRoutes(app, resolved)

  // The terminal routes live inside their own plugin so the websocket support
  // is loaded before the route that needs it. Hooks from the root — headers,
  // token and origin — still apply.
  app.register(async (instance) => {
    await instance.register(websocket, { options: { maxPayload: 64 * 1024 } })
    registerSessionRoutes(instance, config, resolved)
    registerClaudeRoutes(instance, config, resolved)
    registerAccountRoutes(instance, config, resolved)
    registerConnectionRoutes(instance, config, resolved)
  })

  app.addHook('onClose', async () => {
    resolved.watcher.stop()
    resolved.sessions.shutdown()
    resolved.chats.shutdown()
    resolved.designPanels.shutdown()
  })

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
    // Deliberately no stack, no message in the response body. The operator
    // running this console still needs to see what broke, so it goes to this
    // process's own stderr rather than nowhere at all.
    process.stderr.write(
      `fde-gui: unexpected error on ${_request.method} ${_request.url}: ` +
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    return problem(reply, status, 'internal-error', 'The console hit an unexpected error.')
  })

  return app
}
