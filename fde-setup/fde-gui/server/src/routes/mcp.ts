import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { GuiConfig } from '../config'
import { problem } from '../problem'
import { describeZod } from '../schemas/input'
import {
  mcpDetailResponseSchema, mcpEffectiveResponseSchema, mcpFieldIdSchema,
  mcpGatewayResponseSchema, mcpListResponseSchema, mcpServerIdSchema,
} from '../schemas/mcp'
import { ControllerError, runControllerJson, runControllerWithStdin } from '../services/controller'
import type { Services } from '../services/types'
import { accountProblem } from './accounts'

const idParams = z.object({ server: mcpServerIdSchema })
const secretParams = z.object({ server: mcpServerIdSchema, field: mcpFieldIdSchema })
const configureBody = z.object({
  values: z.record(z.string().max(64), z.string().max(2048)).default({}),
})
const secretBody = z.object({ secret: z.string().min(1).max(8192) })
const effectiveQuery = z.object({
  run: z.string().max(80).optional(),
  profile: z.string().max(64).optional(),
  role: z.union([z.string(), z.array(z.string())]).optional(),
  stage: z.union([z.string(), z.array(z.string())]).optional(),
})

function list(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return (Array.isArray(value) ? value : [value]).slice(0, 32)
}

async function call<T>(config: GuiConfig, args: string[], parse: (raw: unknown) => T): Promise<T> {
  return parse(await runControllerJson(config, args))
}

/**
 * The console's window onto the MCP catalogue. Every answer here comes from the
 * controller, which is the only thing that reads the catalogue, the user
 * configuration and the secret store — so the console cannot develop its own,
 * more optimistic, opinion about what a run may reach.
 *
 * Reading this page never starts an MCP server and never downloads a package.
 * Verification is a separate, explicit POST, because that is the call that
 * actually launches something.
 */
export function registerMcpRoutes(app: FastifyInstance, config: GuiConfig, services: Services): void {
  app.get('/api/mcp/servers', async () =>
    await call(config, ['mcp', 'list', '--json'], (v) => mcpListResponseSchema.parse(v)))

  app.get<{ Params: { server: string } }>('/api/mcp/servers/:server', async (request, reply) => {
    const params = idParams.safeParse(request.params)
    if (!params.success) return problem(reply, 400, 'invalid-server', 'Invalid server name.')
    try {
      return await call(config, ['mcp', 'status', params.data.server, '--json'],
        (v) => mcpDetailResponseSchema.parse(v))
    } catch (error) {
      if (error instanceof ControllerError) return accountProblem(reply, error)
      throw error
    }
  })

  app.post<{ Params: { server: string } }>('/api/mcp/servers/:server/configure', async (request, reply) => {
    const params = idParams.safeParse(request.params)
    const body = configureBody.safeParse(request.body)
    if (!params.success || !body.success) {
      return problem(reply, 400, 'invalid-body', 'Invalid configuration.',
        body.success ? undefined : describeZod(body.error))
    }
    const args = ['mcp', 'configure', params.data.server]
    for (const [name, value] of Object.entries(body.data.values)) args.push('--set', `${name}=${value}`)
    args.push('--json')
    try {
      const result = await call(config, args, (v) => mcpDetailResponseSchema.parse(v))
      services.watcher.touch(); return result
    } catch (error) {
      if (error instanceof ControllerError) return accountProblem(reply, error)
      throw error
    }
  })

  // A credential arrives on stdin and is never echoed. The response is the same
  // safe status record every other endpoint returns: presence, never value.
  app.post<{ Params: { server: string, field: string } }>(
    '/api/mcp/servers/:server/secret/:field', async (request, reply) => {
      const params = secretParams.safeParse(request.params)
      const body = secretBody.safeParse(request.body)
      if (!params.success || !body.success) {
        return problem(reply, 400, 'invalid-body', 'A valid server, field and credential are required.')
      }
      try {
        const raw = await runControllerWithStdin(config,
          ['mcp', 'set-secret', params.data.server, params.data.field, '--json'],
          Readable.from([Buffer.from(body.data.secret, 'utf8')]), 8192)
        services.watcher.touch(); return mcpDetailResponseSchema.parse(raw)
      } catch (error) {
        if (error instanceof ControllerError) return accountProblem(reply, error)
        throw error
      }
    })

  app.delete<{ Params: { server: string, field: string } }>(
    '/api/mcp/servers/:server/secret/:field', async (request, reply) => {
      const params = secretParams.safeParse(request.params)
      if (!params.success) return problem(reply, 400, 'invalid-server', 'Invalid server or field.')
      try {
        const result = await call(config,
          ['mcp', 'clear-secret', params.data.server, params.data.field, '--json'],
          (v) => mcpDetailResponseSchema.parse(v))
        services.watcher.touch(); return result
      } catch (error) {
        if (error instanceof ControllerError) return accountProblem(reply, error)
        throw error
      }
    })

  // The only endpoint that starts anything. It performs a bounded initialize and
  // tools/list — never a business operation — and records what the server said
  // it can do, which is what makes an enforceable read-only subset possible.
  app.post<{ Params: { server: string } }>('/api/mcp/servers/:server/verify', async (request, reply) => {
    const params = idParams.safeParse(request.params)
    if (!params.success) return problem(reply, 400, 'invalid-server', 'Invalid server name.')
    try {
      const result = await call(config, ['mcp', 'verify', params.data.server, '--json'],
        (v) => mcpDetailResponseSchema.parse(v))
      services.watcher.touch(); return result
    } catch (error) {
      if (error instanceof ControllerError && typeof error.detail === 'string') {
        try { return mcpDetailResponseSchema.parse(JSON.parse(error.detail)) } catch { /* refusal */ }
        return accountProblem(reply, error)
      }
      if (error instanceof ControllerError) return accountProblem(reply, error)
      throw error
    }
  })

  app.post<{ Params: { server: string } }>('/api/mcp/servers/:server/enable', async (request, reply) => {
    const params = idParams.safeParse(request.params)
    const body = z.object({ enabled: z.boolean() }).safeParse(request.body)
    if (!params.success || !body.success) return problem(reply, 400, 'invalid-body', 'Invalid request.')
    try {
      const result = await call(config,
        ['mcp', body.data.enabled ? 'enable' : 'disable', params.data.server, '--json'],
        (v) => mcpDetailResponseSchema.parse(v))
      services.watcher.touch(); return result
    } catch (error) {
      if (error instanceof ControllerError) return accountProblem(reply, error)
      throw error
    }
  })

  app.get('/api/mcp/effective', async (request, reply) => {
    const query = effectiveQuery.safeParse(request.query)
    if (!query.success) return problem(reply, 400, 'invalid-query', 'Invalid selection.')
    const args = ['mcp', 'effective']
    if (query.data.run) args.push('--run', query.data.run)
    if (query.data.profile) args.push('--profile', query.data.profile)
    for (const role of list(query.data.role)) args.push('--role', role)
    for (const stage of list(query.data.stage)) args.push('--stage', stage)
    args.push('--json')
    try {
      return await call(config, args, (v) => mcpEffectiveResponseSchema.parse(v))
    } catch (error) {
      if (error instanceof ControllerError) return accountProblem(reply, error)
      throw error
    }
  })

  app.get('/api/mcp/gateway', async (request, reply) => {
    const query = z.object({ profile: z.string().max(64).optional() }).safeParse(request.query)
    if (!query.success) return problem(reply, 400, 'invalid-query', 'Invalid profile.')
    const args = ['mcp', 'gateway']
    if (query.data.profile) args.push('--profile', query.data.profile)
    args.push('--json')
    try {
      return await call(config, args, (v) => mcpGatewayResponseSchema.parse(v))
    } catch (error) {
      if (error instanceof ControllerError) return accountProblem(reply, error)
      throw error
    }
  })
}
