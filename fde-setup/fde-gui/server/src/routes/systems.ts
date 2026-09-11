import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { GuiConfig } from '../config'
import { problem } from '../problem'
import { runListSchema, statusSchema } from '../schemas/controller'
import { block } from '../schemas/input'
import { runControllerJson } from '../services/controller'
import {
  DEFAULT_FDE_CONFIGURATION_ID,
  FDE_EXECUTOR_TYPE,
  FDE_SYSTEM_DEFINITION,
  FDE_SYSTEM_TYPE,
  SystemExecutorRegistry,
  ForwardDeployedEngineerExecutor,
  createFdeConfiguration,
  deleteFdeConfiguration,
  getFdeConfiguration,
  listFdeConfigurations,
  listFdeRunRegistrations,
  saveFdeConfiguration,
  validateFdeConfiguration,
  type FdeSystemConfiguration,
} from '../services/fde-systems'
import type { Services } from '../services/types'

const ID = /^[a-z0-9][a-z0-9-]{2,79}$/
const stageSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(160),
  enabled: z.boolean(),
  primaryAccount: z.string().max(80).nullable(),
  reviewerAccount: z.string().max(80).nullable(),
  approvalRequired: z.literal(true),
  capabilityOverrides: z.record(z.enum(['inherit', 'enabled', 'disabled'])),
})
const configurationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(ID),
  version: z.number().int().min(0),
  systemType: z.literal(FDE_SYSTEM_TYPE),
  executorType: z.literal(FDE_EXECUTOR_TYPE),
  name: z.string().min(3).max(120),
  description: z.string().max(1000),
  enabled: z.boolean(),
  projectId: z.string().max(120).nullable(),
  repository: z.string().max(4096).nullable(),
  workspace: z.string().max(4096).nullable(),
  artifactRoot: z.string().min(1).max(1024),
  orchestrator: z.string().min(1).max(80),
  reviewer: z.string().max(80).nullable(),
  routing: z.enum(['auto', 'manual']),
  strategy: z.enum(['balanced', 'quality_first', 'cost_first']),
  model: z.string().min(1).max(256),
  effort: z.enum(['auto', 'low', 'medium', 'high', 'xhigh', 'max']),
  stages: z.array(stageSchema).min(1).max(20),
  governance: z.object({
    approvalAfterEveryStage: z.literal(true),
    approvalBeforeCodeChanges: z.literal(true),
    approvalBeforeDeployment: z.literal(true),
    approvalBeforeProductionMutation: z.literal(true),
    stopOnAmbiguity: z.literal(true),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const createConfigurationSchema = z.object({ name: z.string().trim().min(3).max(120) })
const startSchema = z.object({
  configurationId: z.string().regex(ID),
  businessIntent: block(12_000).pipe(z.string().min(8)),
  projectId: z.string().max(120).optional(),
  orchestrator: z.string().max(80).optional(),
})

function routeError(reply: Parameters<typeof problem>[0], error: unknown) {
  const message = error instanceof Error ? error.message : 'The Forward Deployed Engineer request failed.'
  return problem(reply, 400, 'invalid-fde-system-request', message)
}

export function registerSystemRoutes(app: FastifyInstance, config: GuiConfig, services: Services): void {
  const registry = new SystemExecutorRegistry()
  registry.register(new ForwardDeployedEngineerExecutor(config, services.accounts))

  app.get('/api/system-types', async () => ({ schemaVersion: 1, systemTypes: [FDE_SYSTEM_DEFINITION] }))
  app.get('/api/system-types/forward-deployed-engineer', async () => ({
    schemaVersion: 1,
    systemType: FDE_SYSTEM_DEFINITION,
  }))

  app.get('/api/system-configurations', async () => ({
    schemaVersion: 1,
    configurations: await listFdeConfigurations(config),
  }))

  app.get<{ Params: { id: string } }>('/api/system-configurations/:id', async (request, reply) => {
    if (!ID.test(request.params.id)) return problem(reply, 400, 'invalid-configuration-id', 'Invalid configuration id.')
    const configuration = await getFdeConfiguration(config, request.params.id)
    if (configuration === null) return problem(reply, 404, 'not-found', 'No such system configuration.')
    return { schemaVersion: 1, configuration }
  })

  app.post('/api/system-configurations', async (request, reply) => {
    const parsed = createConfigurationSchema.safeParse(request.body)
    if (!parsed.success) return problem(reply, 400, 'invalid-configuration', 'Enter a configuration name.')
    try {
      const configuration = await createFdeConfiguration(config, parsed.data.name)
      services.watcher.touch()
      return reply.status(201).send({ schemaVersion: 1, configuration })
    } catch (error) { return routeError(reply, error) }
  })

  app.put<{ Params: { id: string } }>('/api/system-configurations/:id', async (request, reply) => {
    if (!ID.test(request.params.id)) return problem(reply, 400, 'invalid-configuration-id', 'Invalid configuration id.')
    const parsed = configurationSchema.safeParse(request.body)
    if (!parsed.success || parsed.data.id !== request.params.id) {
      return problem(reply, 400, 'invalid-configuration', 'The system configuration is not valid.')
    }
    try {
      const configuration = await saveFdeConfiguration(config, parsed.data as FdeSystemConfiguration)
      services.watcher.touch()
      return { schemaVersion: 1, configuration }
    } catch (error) { return routeError(reply, error) }
  })

  app.delete<{ Params: { id: string } }>('/api/system-configurations/:id', async (request, reply) => {
    try {
      await deleteFdeConfiguration(config, request.params.id)
      services.watcher.touch()
      return { schemaVersion: 1, deletedConfiguration: request.params.id, recoverable: false }
    } catch (error) { return routeError(reply, error) }
  })

  app.post<{ Params: { id: string } }>('/api/system-configurations/:id/validate', async (request, reply) => {
    const configuration = await getFdeConfiguration(config, request.params.id)
    if (configuration === null) return problem(reply, 404, 'not-found', 'No such system configuration.')
    const errors = validateFdeConfiguration(configuration)
    return { schemaVersion: 1, valid: errors.length === 0, errors, configuration }
  })

  app.get('/api/fde-runs', async () => {
    const [registrations, listing] = await Promise.all([
      listFdeRunRegistrations(config),
      runControllerJson(config, ['list', '--json']).then((raw) => runListSchema.parse(raw)),
    ])
    const runById = new Map(listing.runs.map((run) => [run.runId, run]))
    return {
      schemaVersion: 1,
      runs: registrations.map((registration) => ({ registration, run: runById.get(registration.runId) ?? null })),
      total: registrations.length,
      warnings: listing.warnings,
    }
  })

  app.get<{ Params: { runId: string } }>('/api/fde-runs/:runId', async (request, reply) => {
    const registration = (await listFdeRunRegistrations(config))
      .find((candidate) => candidate.runId === request.params.runId)
    if (registration === undefined) return problem(reply, 404, 'not-found', 'No such Forward Deployed Engineer run.')
    const status = statusSchema.parse(await runControllerJson(config, [
      'status', request.params.runId, '--json', '--events-limit', '50',
    ]))
    return { schemaVersion: 1, registration, status }
  })

  app.post('/api/fde-runs', async (request, reply) => {
    const parsed = startSchema.safeParse(request.body)
    if (!parsed.success) return problem(reply, 400, 'invalid-fde-run', 'Choose a configuration and provide the business intent.')
    const configuration = await getFdeConfiguration(config, parsed.data.configurationId)
    if (configuration === null) return problem(reply, 404, 'not-found', 'No such system configuration.')
    const executor = registry.get(configuration.executorType)
    if (executor === null) return problem(reply, 503, 'executor-unavailable', 'The Forward Deployed Engineer executor is not registered.')
    const release = services.locks.tryAcquire('run:create')
    if (release === null) return problem(reply, 409, 'busy', 'Another run is being created right now.')
    try {
      const created = await executor.createRun({
        configuration,
        businessIntent: parsed.data.businessIntent,
        projectId: parsed.data.projectId,
        orchestrator: parsed.data.orchestrator,
      })
      services.watcher.touch()
      return reply.status(201).send({ schemaVersion: 1, ...created })
    } catch (error) { return routeError(reply, error) }
    finally { release() }
  })

  app.get<{ Params: { id: string } }>('/api/system-configurations/:id/effective-capabilities', async (request, reply) => {
    const configuration = await getFdeConfiguration(config, request.params.id)
    if (configuration === null) return problem(reply, 404, 'not-found', 'No such system configuration.')
    return await runControllerJson(config, [
      'config', 'show', '--workflow', FDE_SYSTEM_TYPE, '--all', '--json',
    ])
  })

  // The stable default id is public API and is also useful to launch links.
  app.get('/api/fde-default-configuration', async () => ({
    schemaVersion: 1,
    configurationId: DEFAULT_FDE_CONFIGURATION_ID,
  }))
}
