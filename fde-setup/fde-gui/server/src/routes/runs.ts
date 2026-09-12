import path from 'node:path'
import type { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { GuiConfig } from '../config'
import { problem } from '../problem'
import {
  PROJECT_ID_PATTERN,
  RUN_ID_PATTERN,
  runController,
  runControllerJson,
  runControllerWithStdin,
} from '../services/controller'
import {
  attachmentCreatedSchema,
  attachmentListSchema,
  runCreatedSchema,
  runDeletedSchema,
  runListSchema,
  statusSchema,
  type RunSummary,
} from '../schemas/controller'
import { block, describeZod, line } from '../schemas/input'
import type { Services } from '../services/types'
import { ACCOUNT_ID_PATTERN, EFFORTS, MODEL_PATTERN } from '../services/accounts'
import { STRATEGIES as ROUTING_STRATEGIES } from '../schemas/routing'
import {
  FilePathError,
  listRunFiles,
  openFileStream,
  resolveRunDirectory,
  resolveRunFile,
  typeRuleFor,
} from '../services/files'

const runQuerySchema = z.object({
  projectId: z.string().max(120).optional(),
  state: z.string().max(60).optional(),
  orchestrator: z.string().max(60).optional(),
  resumable: z.enum(['true', 'false']).optional(),
  query: z.string().max(200).optional(),
})

const eventsQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

const contentQuerySchema = z.object({
  path: z.string().max(1024),
  disposition: z.enum(['inline', 'attachment']).default('inline'),
})

function matchesQuery(run: RunSummary, needle: string): boolean {
  const haystack = [run.runId, run.requirement ?? '', run.jiraKey ?? '', run.projectId ?? '']
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

/**
 * Creating a run collects only what the brief allows: a project, the ask, an
 * orchestrator, how the model is chosen, and an optional named shape. No
 * specialist roles, no plan approval — those stay in the conversation the run is
 * about to have.
 *
 * `routing: 'auto'` hands the model and effort to the controller and refuses to
 * carry a model or an effort alongside it, because two answers to the same
 * question is how one of them ends up ignored. `manual` is the default and
 * behaves exactly as it did before routing existed, so an existing client that
 * sends `model` and `effort` and nothing else keeps working unchanged.
 */
const createRunBody = z
  .object({
    projectId: z.string().regex(PROJECT_ID_PATTERN, 'not a valid project id').optional(),
    requirement: block(4000).optional(),
    // Not an enum. The identities that exist are whatever the operator has
    // registered — several Claude accounts, several Codex accounts — so a fixed
    // list here would make an account they just added unusable for a run. The
    // pattern bounds what may reach argv; the check below is what decides
    // whether this particular account exists and can be used.
    orchestrator: z.string().regex(ACCOUNT_ID_PATTERN, 'not a configured account'),
    model: z.string().regex(MODEL_PATTERN).optional(),
    effort: z.enum(EFFORTS).optional(),
    routing: z.enum(['auto', 'manual']).default('manual'),
    strategy: z.enum(ROUTING_STRATEGIES).optional(),
    shape: z
      .string()
      .regex(/^[a-z][a-z-]{0,40}(\+[a-z][a-z-]{0,40}){0,4}$/, 'not a named shape')
      .optional(),
  })
  .refine(
    (body) => body.routing !== 'auto' || (body.model === undefined && body.effort === undefined),
    'automatic routing selects the model and effort; do not send them as well',
  )
  .refine(
    (body) => body.routing === 'auto' || body.strategy === undefined,
    'a strategy applies to automatic routing',
  )

const uploadQuery = z.object({
  name: line(255).pipe(z.string().min(1, 'an original filename is required')),
})

const switchOrchestratorBody = z.object({
  accountId: z.string().regex(ACCOUNT_ID_PATTERN, 'not a configured account'),
})

export function registerRunRoutes(
  app: FastifyInstance,
  config: GuiConfig,
  services: Services,
): void {
  const requireRunId = (runId: string): boolean => RUN_ID_PATTERN.test(runId)

  app.get('/api/runs', async (request, reply) => {
    const parsed = runQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return problem(reply, 400, 'invalid-query', 'Unusable filter values.')
    }
    const filters = parsed.data
    const raw = await runControllerJson(config, ['list', '--json'])
    const listing = runListSchema.parse(raw)

    // Filtering and search happen here, over the controller's own answer. The
    // console never decides a run is finished by looking at its artifacts.
    let runs = listing.runs
    if (filters.projectId === 'unassigned') {
      runs = runs.filter((run) => !run.projectId)
    } else if (filters.projectId) {
      runs = runs.filter((run) => run.projectId === filters.projectId)
    }
    if (filters.state) runs = runs.filter((run) => run.state === filters.state)
    if (filters.orchestrator) {
      runs = runs.filter((run) => run.orchestrator?.agentId === filters.orchestrator)
    }
    if (filters.resumable) {
      const want = filters.resumable === 'true'
      runs = runs.filter((run) => run.session.resumable === want)
    }
    if (filters.query && filters.query.trim() !== '') {
      const needle = filters.query.trim().toLowerCase()
      runs = runs.filter((run) => matchesQuery(run, needle))
    }
    runs = [...runs].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))

    return {
      schemaVersion: listing.schemaVersion,
      runs,
      total: listing.runs.length,
      returned: runs.length,
      warnings: listing.warnings,
    }
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (request, reply) => {
    const { runId } = request.params
    if (!requireRunId(runId)) {
      return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
    }
    const raw = await runControllerJson(config, [
      'status',
      runId,
      '--json',
      '--events-limit',
      '50',
    ])
    return statusSchema.parse(raw)
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/events', async (request, reply) => {
    const { runId } = request.params
    if (!requireRunId(runId)) {
      return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
    }
    const parsed = eventsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return problem(reply, 400, 'invalid-query', 'Unusable paging values.')
    }
    const args = ['status', runId, '--json', '--events-limit', String(parsed.data.limit)]
    if (parsed.data.cursor !== undefined) args.push('--events-cursor', String(parsed.data.cursor))
    const status = statusSchema.parse(await runControllerJson(config, args))
    return { schemaVersion: status.schemaVersion, runId: status.runId, events: status.events }
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/attachments', async (request, reply) => {
    const { runId } = request.params
    if (!requireRunId(runId)) {
      return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
    }
    const raw = await runControllerJson(config, ['attachments', runId, '--json'])
    return attachmentListSchema.parse(raw)
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/files', async (request, reply) => {
    const { runId } = request.params
    if (!requireRunId(runId)) {
      return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
    }
    try {
      const runDir = await resolveRunDirectory(config.runsRoot, runId)
      const listing = await listRunFiles(runDir)
      return { runId, ...listing }
    } catch (error) {
      if (error instanceof FilePathError) {
        return problem(reply, error.status, error.code, error.message)
      }
      throw error
    }
  })

  app.get<{ Params: { runId: string } }>(
    '/api/runs/:runId/files/content',
    async (request, reply) => {
      const { runId } = request.params
      if (!requireRunId(runId)) {
        return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
      }
      const parsed = contentQuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return problem(reply, 400, 'invalid-query', 'A file path is required.')
      }
      try {
        const runDir = await resolveRunDirectory(config.runsRoot, runId)
        const file = await resolveRunFile(runDir, parsed.data.path)
        const rule = typeRuleFor(file.relativePath)
        const inline = parsed.data.disposition === 'inline' && rule.inline
        const truncate = inline && rule.preview !== 'image' && rule.preview !== 'pdf'
        const limit = truncate ? config.maxTextPreviewBytes : undefined
        const truncated = limit !== undefined && file.stats.size > limit

        // A file response is inert: its own restrictive policy, no sniffing, and
        // a download disposition for everything outside the preview allowlist.
        reply.header('content-security-policy', "default-src 'none'; sandbox")
        reply.header('x-content-type-options', 'nosniff')
        reply.header('content-type', inline ? `${rule.mediaType}; charset=utf-8` : 'application/octet-stream')
        reply.header(
          'content-disposition',
          `${inline ? 'inline' : 'attachment'}; filename="${path.basename(file.relativePath).replace(/[^A-Za-z0-9._-]/g, '_')}"`,
        )
        reply.header('x-fde-file-size', String(file.stats.size))
        reply.header('x-fde-truncated', truncated ? 'true' : 'false')
        if (!truncated) reply.header('content-length', String(file.stats.size))
        return reply.send(openFileStream(file, limit))
      } catch (error) {
        if (error instanceof FilePathError) {
          return problem(reply, error.status, error.code, error.message)
        }
        throw error
      }
    },
  )

  // -- mutations. Every write goes through a controller command. -------------

  app.post('/api/runs', async (request, reply) => {
    const parsed = createRunBody.safeParse(request.body)
    if (!parsed.success) {
      return problem(reply, 400, 'invalid-body', 'That run cannot be created as described.',
        describeZod(parsed.error))
    }
    // In automatic mode there is nothing to validate here: the controller has
    // not chosen yet, and it only ever chooses from what this same catalogue
    // offers. In manual mode the browser may pick only from what this server
    // showed it, exactly as before.
    const manualModel = parsed.data.model ?? 'default'
    const manualEffort = parsed.data.effort ?? 'auto'
    const orchestrator = services.accounts.getConfigured(parsed.data.orchestrator)
    if (orchestrator === null) {
      return problem(
        reply,
        400,
        'unknown-orchestrator',
        'That account is not registered as an orchestrator for this console.',
        'Add it under AI accounts, or pick one that is listed.',
      )
    }
    // The controller knows identities by registry key. A profile directory the
    // operator created but never registered can be signed in and can hold a
    // chat, but it is not an identity, so it cannot be given a run — and
    // saying that here is better than forwarding a name the controller will
    // refuse as unknown.
    if (orchestrator.identityId === null) {
      return problem(
        reply,
        400,
        'orchestrator-not-registered',
        `"${orchestrator.label}" is a profile folder with no identity registered for it.`,
        'Register it under AI accounts, then it can orchestrate a run.',
      )
    }
    if (!orchestrator.capabilities.includes('orchestration')) {
      return problem(
        reply,
        400,
        'orchestrator-capability-required',
        'That identity can work in a run, but it is not permitted to orchestrate one.',
        'Choose it for a supported specialist role after the run starts, or select an orchestrator-capable account.',
      )
    }
    // Which checks apply is decided by the account's provider, not by its id.
    // With one hard-coded Codex account the two were the same string; with as
    // many as the operator registers they are not.
    const isCodex = orchestrator.provider === 'codex'
    if (
      parsed.data.routing === 'manual' &&
      !isCodex &&
      !services.accounts.validateSelection(
        parsed.data.orchestrator,
        manualModel,
        manualEffort,
      )
    ) {
      return problem(
        reply,
        400,
        'invalid-selection',
        'That model and effort combination is not available for this account.',
      )
    }
    if (!isCodex) {
      const auth = await services.accounts.status(parsed.data.orchestrator)
      if (auth.state === 'login_required') {
        return problem(
          reply,
          409,
          'login-required',
          'Sign in to this Claude account before creating the run.',
        )
      }
      if (auth.state === 'unavailable') {
        return problem(
          reply,
          503,
          'claude-unavailable',
          'The selected Claude account is not available.',
        )
      }
    }
    const release = services.locks.tryAcquire('run:create')
    if (release === null) {
      return problem(reply, 409, 'busy', 'Another run is being created right now.')
    }
    try {
      // The registry key, never this console\'s own handle: with several
      // accounts registered a bare profile name can name two identities, and
      // the controller correctly refuses an ambiguous one.
      const args = ['start', '--json', '--orchestrator', orchestrator.identityId]
      if (parsed.data.routing === 'auto') {
        args.push('--routing', 'auto', '--strategy', parsed.data.strategy ?? 'balanced')
      } else if (!isCodex) {
        args.push('--model', manualModel, '--effort', manualEffort)
      }
      if (parsed.data.projectId !== undefined) args.push('--project', parsed.data.projectId)
      if (parsed.data.shape !== undefined) args.push('--shape', parsed.data.shape)
      // Everything after `--` is the ask, so a requirement that starts with a
      // dash is text and never a flag.
      if (parsed.data.requirement !== undefined && parsed.data.requirement.trim() !== '') {
        args.push('--', parsed.data.requirement)
      }
      const raw = await runControllerJson(config, args)
      services.watcher.touch()
      return await reply.status(201).send(runCreatedSchema.parse(raw))
    } finally {
      release()
    }
  })

  app.post<{ Params: { runId: string } }>(
    '/api/runs/:runId/orchestrator',
    async (request, reply) => {
      const { runId } = request.params
      if (!requireRunId(runId)) {
        return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
      }
      const parsed = switchOrchestratorBody.safeParse(request.body)
      if (!parsed.success) {
        return problem(reply, 400, 'invalid-body', 'Choose a configured orchestrator account.',
          describeZod(parsed.error))
      }

      const releaseRun = services.locks.tryAcquire(`run:${runId}`)
      if (releaseRun === null) {
        return problem(reply, 409, 'busy', 'This run is being changed right now.')
      }
      const releaseSession = services.locks.tryAcquire(`session:${runId}`)
      if (releaseSession === null) {
        releaseRun()
        return problem(reply, 409, 'busy', 'This run is starting or changing its console session.')
      }
      try {
        if (services.sessions.isRunning(runId)) {
          return problem(
            reply,
            409,
            'session-active',
            'Stop the orchestrator session before switching accounts.',
            'Stopping first prevents two account identities from acting as the same run at once.',
          )
        }

        const before = statusSchema.parse(
          await runControllerJson(config, ['status', runId, '--json', '--events-limit', '1']),
        )
        const account = services.accounts.getConfigured(parsed.data.accountId)
        if (account === null || account.identityId === null) {
          return problem(
            reply,
            400,
            'unknown-orchestrator',
            'That account is not registered as an orchestrator for this console.',
            'Add it under AI accounts, or choose another listed account.',
          )
        }
        if (!account.capabilities.includes('orchestration')) {
          return problem(
            reply,
            400,
            'orchestrator-capability-required',
            'That identity is not permitted to orchestrate a run.',
          )
        }
        if (account.provider === 'codex' || account.provider === 'gemini') {
          return problem(
            reply,
            400,
            'interactive-orchestrator-required',
            'Choose a Claude account that can continue this run in the Session tab.',
          )
        }
        if (before.roles.orchestrator?.agentId === account.identityId) {
          return problem(reply, 409, 'orchestrator-unchanged', 'That account already orchestrates this run.')
        }
        const auth = await services.accounts.status(account.id, true)
        if (auth.state === 'login_required') {
          return problem(reply, 409, 'login-required', 'Sign in to that account before switching.')
        }
        if (auth.state === 'unavailable') {
          return problem(reply, 503, 'account-unavailable', 'The selected account is not available.')
        }

        // The explicit --reassign is the operator's requested identity change.
        // It approves nothing: an approved automatic route becomes stale and
        // must still be reviewed and re-approved in the replacement session.
        await runController(config, [
          'orchestrator', runId, account.identityId, '--reassign',
        ])
        const run = statusSchema.parse(
          await runControllerJson(config, ['status', runId, '--json', '--events-limit', '50']),
        )
        services.watcher.touch()
        return {
          schemaVersion: 1,
          switched: true,
          previousOrchestrator: before.roles.orchestrator,
          run,
          reapprovalRequired: run.nextAction?.includes('approve-plan') ?? false,
        }
      } finally {
        releaseSession()
        releaseRun()
      }
    },
  )

  app.delete<{ Params: { runId: string } }>('/api/runs/:runId', async (request, reply) => {
    const { runId } = request.params
    if (!requireRunId(runId)) {
      return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
    }
    const releaseRun = services.locks.tryAcquire(`run:${runId}`)
    if (releaseRun === null) return problem(reply, 409, 'busy', 'This run is being changed right now.')
    const releaseSession = services.locks.tryAcquire(`session:${runId}`)
    if (releaseSession === null) {
      releaseRun()
      return problem(reply, 409, 'busy', 'This run is starting or changing its console session.')
    }
    const releasePanel = services.designPanels.beginRunDeletion(runId)
    if (releasePanel === null) {
      releaseSession()
      releaseRun()
      return problem(reply, 409, 'run-active', 'Stop all design-panel work before deleting this run.')
    }
    let releaseProject = (): void => undefined
    try {
      if (services.sessions.isRunning(runId)) {
        return problem(reply, 409, 'run-active', 'Stop this run’s console session before deleting it.')
      }
      const status = statusSchema.parse(
        await runControllerJson(config, ['status', runId, '--json', '--events-limit', '1']),
      )
      if (status.projectId) {
        const acquired = services.locks.tryAcquire(`project:${status.projectId}`)
        if (acquired === null) {
          return problem(reply, 409, 'busy', 'This run’s project is being changed right now.')
        }
        releaseProject = acquired
      }
      const raw = await runControllerJson(
        config,
        ['delete', runId, '--confirm', runId, '--json'],
      )
      const deleted = runDeletedSchema.parse(raw)
      if (services.sessions.get(runId) !== null) services.sessions.delete(runId)
      services.watcher.touch()
      return deleted
    } finally {
      releaseProject()
      releasePanel()
      releaseSession()
      releaseRun()
    }
  })

  app.post<{ Params: { runId: string } }>(
    '/api/runs/:runId/attachments',
    { bodyLimit: config.maxUploadBytes },
    async (request, reply) => {
      const { runId } = request.params
      if (!requireRunId(runId)) {
        return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
      }
      const parsed = uploadQuery.safeParse(request.query)
      if (!parsed.success) {
        return problem(reply, 400, 'invalid-query', 'The upload needs its original filename.',
          describeZod(parsed.error))
      }
      const release = services.locks.tryAcquire(`run:${runId}`)
      if (release === null) {
        return problem(reply, 409, 'busy', 'This run is busy. Refresh and try again.')
      }
      try {
        // The bytes go to the controller's stdin. The browser's filename is a
        // label the controller sanitizes; it never reaches a path here.
        const raw = await runControllerWithStdin(
          config,
          [
            'attach',
            runId,
            '--stdin',
            '--name',
            parsed.data.name,
            '--max-bytes',
            String(config.maxUploadBytes),
            '--json',
          ],
          request.body as Readable,
          config.maxUploadBytes,
        )
        services.watcher.touch()
        return await reply.status(201).send(attachmentCreatedSchema.parse(raw))
      } finally {
        release()
      }
    },
  )
}
