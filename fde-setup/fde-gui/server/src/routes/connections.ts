import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { GuiConfig } from '../config'
import { problem } from '../problem'
import { describeZod } from '../schemas/input'
import {
  connectionDetailResponseSchema, connectionListResponseSchema,
  connectionProvidersResponseSchema, connectionRemovedResponseSchema,
} from '../schemas/connections'
import { ControllerError, runControllerJson, runControllerWithStdin } from '../services/controller'
import type { Services } from '../services/types'
import { accountProblem } from './accounts'

const idParams = z.object({ connectionId: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/) })
const createBody = z.object({
  provider: z.enum(['atlassian', 'atlassian-rovo', 'github', 'bitbucket', 'figma']),
  name: z.string().trim().min(1).max(49),
  fields: z.record(z.string(), z.string().max(300)).default({}),
})
const secretBody = z.object({ secret: z.string().min(1).max(8192) })

async function call<T>(config: GuiConfig, args: string[], parse: (raw: unknown) => T): Promise<T> {
  return parse(await runControllerJson(config, args))
}

export function registerConnectionRoutes(app: FastifyInstance, config: GuiConfig, services: Services): void {
  app.get('/api/connections/providers', async () =>
    await call(config, ['connections', 'providers', '--json'], (v) => connectionProvidersResponseSchema.parse(v)))
  app.get('/api/connections', async () =>
    await call(config, ['connections', 'list', '--json'], (v) => connectionListResponseSchema.parse(v)))

  app.post('/api/connections', async (request, reply) => {
    const body = createBody.safeParse(request.body)
    if (!body.success) return problem(reply, 400, 'invalid-body', 'Invalid connection.', describeZod(body.error))
    const args = ['connections', 'add', '--provider', body.data.provider, '--name', body.data.name]
    if (body.data.fields.siteUrl) args.push('--site-url', body.data.fields.siteUrl)
    if (body.data.fields.email) args.push('--email', body.data.fields.email)
    args.push('--json')
    try {
      const result = await call(config, args, (v) => connectionDetailResponseSchema.parse(v))
      services.watcher.touch(); return reply.code(201).send(result)
    } catch (error) {
      if (error instanceof ControllerError) return accountProblem(reply, error)
      throw error
    }
  })

  app.post<{ Params: { connectionId: string } }>('/api/connections/:connectionId/secret', async (request, reply) => {
    const params = idParams.safeParse(request.params); const body = secretBody.safeParse(request.body)
    if (!params.success || !body.success) return problem(reply, 400, 'invalid-body', 'A valid connection and token are required.')
    try {
      const raw = await runControllerWithStdin(config,
        ['connections', 'set-secret', params.data.connectionId, '--json'],
        Readable.from([Buffer.from(body.data.secret, 'utf8')]), 8192)
      services.watcher.touch(); return connectionDetailResponseSchema.parse(raw)
    } catch (error) {
      if (error instanceof ControllerError) return accountProblem(reply, error)
      throw error
    }
  })

  app.post<{ Params: { connectionId: string } }>('/api/connections/:connectionId/verify', async (request, reply) => {
    const params = idParams.safeParse(request.params)
    if (!params.success) return problem(reply, 400, 'invalid-connection', 'Invalid connection id.')
    try {
      const result = await call(config, ['connections', 'verify', params.data.connectionId, '--json'],
        (v) => connectionDetailResponseSchema.parse(v))
      services.watcher.touch(); return result
    } catch (error) {
      if (error instanceof ControllerError && typeof error.detail === 'string') {
        try { return connectionDetailResponseSchema.parse(JSON.parse(error.detail)) } catch { /* refusal */ }
        return accountProblem(reply, error)
      }
      throw error
    }
  })

  app.delete<{ Params: { connectionId: string } }>('/api/connections/:connectionId', async (request, reply) => {
    const params = idParams.safeParse(request.params)
    if (!params.success) return problem(reply, 400, 'invalid-connection', 'Invalid connection id.')
    try {
      const result = await call(config, ['connections', 'remove', params.data.connectionId, '--json'],
        (v) => connectionRemovedResponseSchema.parse(v))
      services.watcher.touch(); return result
    } catch (error) {
      if (error instanceof ControllerError) return accountProblem(reply, error)
      throw error
    }
  })
}
