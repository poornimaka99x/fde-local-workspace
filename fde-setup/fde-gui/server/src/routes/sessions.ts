import { existsSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { isExecutable, type GuiConfig } from '../config'
import { problem } from '../problem'
import { RUN_ID_PATTERN, runControllerJson } from '../services/controller'
import { statusSchema } from '../schemas/controller'
import { FilePathError, resolveRunDirectory } from '../services/files'
import { NoSuchSession, SessionActive, SessionExists, sessionCwd, sessionEnv } from '../services/sessions'
import type { Services } from '../services/types'

const stopBody = z.object({ force: z.boolean().default(false) }).default({ force: false })
const LOGIN_SESSION_PATTERN = /^login:[a-z][a-z0-9_-]{0,39}$/

interface ClientMessage {
  type?: unknown
  data?: unknown
  cols?: unknown
  rows?: unknown
}

export function registerSessionRoutes(
  app: FastifyInstance,
  config: GuiConfig,
  services: Services,
): void {
  const { sessions } = services

  app.get('/api/sessions', async () => ({
    available: sessions.available,
    sessions: sessions.list(),
  }))

  app.delete<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params
    if (!RUN_ID_PATTERN.test(sessionId) && !LOGIN_SESSION_PATTERN.test(sessionId)) {
      return problem(reply, 400, 'invalid-session-id', 'That is not a valid session id.')
    }
    const release = services.locks.tryAcquire(`session:${sessionId}`)
    if (release === null) return problem(reply, 409, 'busy', 'This session is being changed right now.')
    try {
      sessions.delete(sessionId)
      services.watcher.touch()
      return { deleted: { kind: 'session-history', sessionId } }
    } catch (error) {
      if (error instanceof NoSuchSession) {
        return problem(reply, 404, 'no-session', 'This console has no such session history.')
      }
      if (error instanceof SessionActive) {
        return problem(reply, 409, 'session-active', 'Stop this session before deleting its history.')
      }
      throw error
    } finally {
      release()
    }
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/session', async (request, reply) => {
    const { runId } = request.params
    if (!RUN_ID_PATTERN.test(runId)) {
      return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
    }
    return { available: sessions.available, session: sessions.get(runId) }
  })

  /**
   * Resume starts exactly one command: `fde-start --resume <run-id>`, for a run
   * the controller says is resumable. It is never given a command, a shell or a
   * working directory by the caller.
   */
  app.post<{ Params: { runId: string } }>(
    '/api/runs/:runId/session/resume',
    async (request, reply) => {
      const { runId } = request.params
      if (!RUN_ID_PATTERN.test(runId)) {
        return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
      }
      try {
        await resolveRunDirectory(config.runsRoot, runId)
      } catch (error) {
        if (error instanceof FilePathError) {
          return problem(reply, error.status, error.code, error.message)
        }
        throw error
      }

      // Already running: hand back the same session and a fresh ticket, so a
      // second tab attaches instead of starting a second process.
      if (sessions.isRunning(runId)) {
        return {
          status: 'existing',
          session: sessions.get(runId),
          ticket: sessions.issueTicket(runId),
        }
      }

      const status = statusSchema.parse(
        await runControllerJson(config, ['status', runId, '--json', '--events-limit', '1']),
      )
      if (status.session.provider !== 'claude' || !status.session.resumable) {
        return problem(
          reply,
          409,
          'session-not-resumable',
          'This run cannot be resumed from the console.',
          status.session.resumeReason ??
            'The controller does not report a resumable Claude session for this run.',
        )
      }
      if (!isExecutable(config.fdeStartBin)) {
        return problem(reply, 503, 'launcher-unavailable',
          'The fde-start launcher is not available.', `No launcher at ${config.fdeStartBin}.`)
      }
      if (!sessions.available) {
        return problem(
          reply,
          503,
          'terminal-unavailable',
          'This installation has no terminal backend.',
          'node-pty is not installed here, so the console will not start a session. ' +
            'Resume the run from a terminal with: fde-start --resume ' + runId,
        )
      }

      const release = services.locks.tryAcquire(`session:${runId}`)
      if (release === null) {
        return problem(reply, 409, 'busy', 'This run is already starting a session.')
      }
      try {
        const repoPaths = status.project?.repoPaths ?? []
        const view = sessions.start({
          runId,
          startBin: config.fdeStartBin,
          cwd: sessionCwd(config, repoPaths, existsSync),
          env: sessionEnv(config),
        })
        services.watcher.touch()
        return await reply.status(201).send({
          status: 'started',
          session: view,
          ticket: sessions.issueTicket(runId),
        })
      } catch (error) {
        if (error instanceof SessionExists) {
          return {
            status: 'existing',
            session: sessions.get(runId),
            ticket: sessions.issueTicket(runId),
          }
        }
        throw error
      } finally {
        release()
      }
    },
  )

  app.delete<{ Params: { runId: string } }>(
    '/api/runs/:runId/session',
    async (request, reply) => {
      const { runId } = request.params
      if (!RUN_ID_PATTERN.test(runId)) {
        return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
      }
      const release = services.locks.tryAcquire(`session:${runId}`)
      if (release === null) return problem(reply, 409, 'busy', 'This session is being changed right now.')
      try {
        sessions.delete(runId)
        services.watcher.touch()
        return { deleted: { kind: 'session-history', runId } }
      } catch (error) {
        if (error instanceof NoSuchSession) {
          return problem(reply, 404, 'no-session', 'This run has no console session history.')
        }
        if (error instanceof SessionActive) {
          return problem(reply, 409, 'session-active', 'Stop this session before deleting its history.')
        }
        throw error
      } finally {
        release()
      }
    },
  )

  app.post<{ Params: { runId: string } }>(
    '/api/runs/:runId/session/stop',
    async (request, reply) => {
      const { runId } = request.params
      if (!RUN_ID_PATTERN.test(runId)) {
        return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
      }
      const parsed = stopBody.safeParse(request.body ?? {})
      if (!parsed.success) {
        return problem(reply, 400, 'invalid-body', 'Unusable stop request.')
      }
      try {
        return sessions.stop(runId, { force: parsed.data.force })
      } catch (error) {
        if (error instanceof NoSuchSession) {
          return problem(reply, 404, 'no-session', 'This run has no console session.')
        }
        throw error
      }
    },
  )

  /**
   * The terminal stream. Authenticated by a single-use ticket issued over the
   * authenticated resume call, because a browser cannot set headers on a
   * WebSocket; the origin check still applies to the upgrade.
   */
  app.get<{ Params: { runId: string }; Querystring: { ticket?: string } }>(
    '/api/runs/:runId/session/terminal',
    { websocket: true },
    (socket, request) => {
      const { runId } = request.params
      const ticket = typeof request.query.ticket === 'string' ? request.query.ticket : ''
      if (!RUN_ID_PATTERN.test(runId) || ticket === '' || !sessions.redeemTicket(ticket, runId)) {
        socket.close(4401, 'unauthenticated')
        return
      }

      const send = (payload: unknown): void => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload))
      }

      let attached: { detach: () => void } | null = null
      try {
        const attachment = sessions.attach(
          runId,
          (chunk) => send({ type: 'output', data: chunk }),
          (exitCode) => send({ type: 'exit', exitCode }),
        )
        attached = attachment
        send({ type: 'ready', session: attachment.view, backlog: attachment.backlog })
      } catch {
        socket.close(4404, 'no session')
        return
      }

      socket.on('message', (raw: Buffer) => {
        let message: ClientMessage
        try {
          message = JSON.parse(raw.toString('utf8')) as ClientMessage
        } catch {
          return
        }
        if (message.type === 'input' && typeof message.data === 'string') {
          try {
            sessions.write(runId, message.data)
          } catch {
            send({ type: 'exit', exitCode: sessions.get(runId)?.exitCode ?? 0 })
          }
          return
        }
        if (
          message.type === 'resize' &&
          typeof message.cols === 'number' &&
          typeof message.rows === 'number'
        ) {
          sessions.resize(runId, Math.floor(message.cols), Math.floor(message.rows))
        }
      })

      // Closing a tab detaches a viewer. It never stops the process — that is
      // what the explicit Stop action is for.
      socket.on('close', () => attached?.detach())
    },
  )
}
