import path from 'node:path'
import type { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { GuiConfig } from '../config'
import { problem } from '../problem'
import {
  PROJECT_ID_PATTERN,
  RUN_ID_PATTERN,
  runControllerJson,
  runControllerWithStdin,
} from '../services/controller'
import {
  attachmentCreatedSchema,
  attachmentListSchema,
  runCreatedSchema,
  runListSchema,
  statusSchema,
  type RunSummary,
} from '../schemas/controller'
import { block, describeZod, line } from '../schemas/input'
import type { Services } from '../services/types'
import { EFFORTS, MODEL_PATTERN } from '../services/accounts'
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
 * orchestrator and an optional named shape. No specialist roles, no plan
 * approval — those stay in the conversation the run is about to have.
 */
const createRunBody = z.object({
  projectId: z.string().regex(PROJECT_ID_PATTERN, 'not a valid project id').optional(),
  requirement: block(4000).optional(),
  orchestrator: z.enum(['work', 'msc', 'alt', 'bedrock', 'codex']),
  model: z.string().regex(MODEL_PATTERN).default('default'),
  effort: z.enum(EFFORTS).default('auto'),
  shape: z
    .string()
    .regex(/^[a-z][a-z-]{0,40}(\+[a-z][a-z-]{0,40}){0,4}$/, 'not a named shape')
    .optional(),
})

const uploadQuery = z.object({
  name: line(255).pipe(z.string().min(1, 'an original filename is required')),
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
    const release = services.locks.tryAcquire('run:create')
    if (release === null) {
      return problem(reply, 409, 'busy', 'Another run is being created right now.')
    }
    try {
      if (
        parsed.data.orchestrator !== 'codex' &&
        !services.accounts.validateSelection(
          parsed.data.orchestrator,
          parsed.data.model,
          parsed.data.effort,
        )
      ) {
        return problem(
          reply,
          400,
          'invalid-selection',
          'That model and effort combination is not available for this account.',
        )
      }
      const args = ['start', '--json', '--orchestrator', parsed.data.orchestrator]
      if (parsed.data.orchestrator !== 'codex') {
        args.push('--model', parsed.data.model, '--effort', parsed.data.effort)
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
