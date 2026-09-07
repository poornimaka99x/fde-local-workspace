import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { GuiConfig } from '../config'
import { problem } from '../problem'
import {
  ControllerError,
  PROJECT_ID_PATTERN,
  RUN_ID_PATTERN,
  runControllerJson,
  runControllerWithStdin,
} from '../services/controller'
import {
  STRATEGIES,
  routingAttemptsSchema,
  routingExplainSchema,
  routingOverrideSchema,
  routingPolicySchema,
  routingPreviewSchema,
  routingReportSchema,
  routingShowSchema,
} from '../schemas/routing'
import { block, describeZod, line } from '../schemas/input'
import { EFFORTS, MODEL_PATTERN } from '../services/accounts'
import type { Services } from '../services/types'

/**
 * The routing API.
 *
 * Three rules hold for everything here.
 *
 * 1. **The controller decides.** Every endpoint is a controller JSON command.
 *    This server does not score complexity, choose a model, build a specialist
 *    plan, or write `routing.json` — it cannot, because it never opens those
 *    files.
 * 2. **Nothing here approves anything.** There is no endpoint that can clear the
 *    `APPROVE PLAN` gate. Escalating an override still needs the operator to
 *    type its phrase, and this server passes `--approve` only when the phrase
 *    it received matches exactly.
 * 3. **The request text is never argv.** A requirement goes to the controller's
 *    stdin, so a request beginning with a dash is text and can never be read as
 *    a flag.
 *
 * Answers are validated against the pinned schemas before they reach the
 * browser, and the existing bearer-token and origin checks apply to all of it
 * from the root hooks.
 */

const TASK_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const ACCOUNT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/
const SHAPE_PATTERN = /^[a-z][a-z-]{0,40}(\+[a-z][a-z-]{0,40}){0,4}$/
const STAGE_PATTERN = /^[a-z][a-z-]{0,30}$/
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/**
 * A requirement short enough not to be worth previewing.
 *
 * Below this the assessment has almost nothing to read and would mostly be
 * reporting its own uncertainty, so the form waits rather than showing a
 * confident-looking answer to half a sentence.
 */
export const PREVIEW_MIN_REQUIREMENT_CHARS = 24

const previewBody = z.object({
  orchestrator: z.string().regex(ACCOUNT_ID_PATTERN, 'not a configured account'),
  strategy: z.enum(STRATEGIES).default('balanced'),
  requirement: block(4000),
  shape: z.string().regex(SHAPE_PATTERN, 'not a named shape').optional(),
  stages: z.array(z.string().regex(STAGE_PATTERN)).max(12).optional(),
  projectId: z.string().regex(PROJECT_ID_PATTERN, 'not a valid project id').optional(),
})

const overrideBody = z
  .object({
    taskId: z.string().regex(TASK_ID_PATTERN, 'not a routed task id').optional(),
    orchestrator: z.boolean().default(false),
    model: z.string().regex(MODEL_PATTERN).optional(),
    effort: z.enum(EFFORTS).optional(),
    account: z.string().regex(ACCOUNT_ID_PATTERN).optional(),
    reason: line(500).pipe(z.string().min(1, 'an override needs a reason')),
    confirmation: line(200).optional(),
  })
  .refine((body) => body.orchestrator !== (body.taskId !== undefined),
    'name exactly one of taskId or orchestrator')

const explainQuery = z.object({
  taskId: z.string().regex(TASK_ID_PATTERN).optional(),
})

const reportQuery = z.object({
  projectId: z.string().regex(PROJECT_ID_PATTERN).optional(),
  since: z.string().regex(ISO_PATTERN, 'not a timestamp').optional(),
  minSample: z.coerce.number().int().min(1).max(1000).optional(),
})

/**
 * The controller's own typed refusal, surfaced as itself.
 *
 * In JSON mode a routing refusal is `{"error":{code,message,hint}}` on stdout
 * with a documented exit code, which arrives here as the ControllerError's
 * detail. Parsing it back means the browser sees `routing-below-floor` rather
 * than a generic "the controller refused this request", and can say something
 * useful about it. Anything that is not that shape falls through to the generic
 * mapping untouched.
 */
export function routingProblem(reply: FastifyReply, error: ControllerError): unknown {
  if (typeof error.detail === 'string') {
    try {
      const parsed = JSON.parse(error.detail) as {
        error?: { code?: unknown; message?: unknown; hint?: unknown }
      }
      const code = parsed.error?.code
      const message = parsed.error?.message
      if (typeof code === 'string' && typeof message === 'string') {
        return problem(
          reply,
          error.status,
          code,
          message,
          typeof parsed.error?.hint === 'string' ? parsed.error.hint : undefined,
        )
      }
    } catch {
      /* Not a routing envelope. The generic mapping is the right answer. */
    }
  }
  return problem(reply, error.status, error.code, error.message, error.detail)
}

async function controllerJson(
  config: GuiConfig,
  reply: FastifyReply,
  args: readonly string[],
  parse: (raw: unknown) => unknown,
): Promise<unknown> {
  try {
    return parse(await runControllerJson(config, args))
  } catch (error) {
    if (error instanceof ControllerError) return routingProblem(reply, error)
    throw error
  }
}

export function registerRoutingRoutes(
  app: FastifyInstance,
  config: GuiConfig,
  services: Services,
): void {
  const badRunId = (runId: string): boolean => !RUN_ID_PATTERN.test(runId)

  /** What this controller can be asked, so the form can feature-detect. */
  app.get('/api/routing/policy', async () => {
    const raw = await runControllerJson(config, ['version', '--json'])
    const parsed = routingPolicySchema.parse(raw)
    return {
      capabilities: parsed.capabilities,
      contracts: parsed.contracts,
      policy: parsed.routingPolicy ?? {
        state: 'unavailable' as const,
        message: 'this controller does not report a routing policy',
      },
      previewMinRequirementChars: PREVIEW_MIN_REQUIREMENT_CHARS,
      strategies: [...STRATEGIES],
    }
  })

  /**
   * Score a request and show what it would be routed to.
   *
   * Creates no run and writes nothing. It is a POST because the request text is
   * a body, not because it changes anything.
   */
  app.post('/api/routing/preview', async (request, reply) => {
    const parsed = previewBody.safeParse(request.body)
    if (!parsed.success) {
      return problem(reply, 400, 'invalid-body', 'That preview cannot be requested as described.',
        describeZod(parsed.error))
    }
    const requirement = parsed.data.requirement.trim()
    if (requirement.length < PREVIEW_MIN_REQUIREMENT_CHARS) {
      return problem(reply, 400, 'requirement-too-short',
        'There is not enough of the request to assess yet.',
        `Say at least ${PREVIEW_MIN_REQUIREMENT_CHARS} characters about what you want done.`)
    }
    if (parsed.data.shape !== undefined && parsed.data.stages !== undefined) {
      return problem(reply, 400, 'invalid-body',
        'Give a named shape or a list of stages, not both.')
    }
    // The account is an operator decision, so its availability is checked here
    // rather than being discovered as a routing failure.
    if (!services.accounts.getConfigured(parsed.data.orchestrator)) {
      return problem(reply, 400, 'unknown-account', 'That is not a configured account.')
    }
    const args = [
      'routing', 'preview',
      '--orchestrator', parsed.data.orchestrator,
      '--strategy', parsed.data.strategy,
      '--requirement-stdin', '--json',
    ]
    if (parsed.data.shape !== undefined) args.push('--shape', parsed.data.shape)
    if (parsed.data.stages !== undefined && parsed.data.stages.length > 0) {
      args.push('--stages', parsed.data.stages.join(','))
    }
    if (parsed.data.projectId !== undefined) args.push('--project', parsed.data.projectId)
    try {
      // The request text goes to stdin, never to argv.
      const raw = await runControllerWithStdin(
        config,
        args,
        Readable.from([Buffer.from(requirement, 'utf8')]),
        64 * 1024,
      )
      return routingPreviewSchema.parse(raw)
    } catch (error) {
      if (error instanceof ControllerError) return routingProblem(reply, error)
      throw error
    }
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/routing', async (request, reply) => {
    const { runId } = request.params
    if (badRunId(runId)) return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
    return await controllerJson(config, reply, ['routing', 'show', runId, '--json'],
      (raw) => routingShowSchema.parse(raw))
  })

  app.get<{ Params: { runId: string } }>(
    '/api/runs/:runId/routing/explain',
    async (request, reply) => {
      const { runId } = request.params
      if (badRunId(runId)) return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
      const parsed = explainQuery.safeParse(request.query)
      if (!parsed.success) {
        return problem(reply, 400, 'invalid-query', 'That is not a routed task id.')
      }
      const args = ['routing', 'explain', runId, '--json']
      if (parsed.data.taskId !== undefined) args.push('--task-id', parsed.data.taskId)
      return await controllerJson(config, reply, args,
        (raw) => routingExplainSchema.parse(raw))
    },
  )

  app.get<{ Params: { runId: string } }>(
    '/api/runs/:runId/routing/attempts',
    async (request, reply) => {
      const { runId } = request.params
      if (badRunId(runId)) return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
      const parsed = explainQuery.safeParse(request.query)
      if (!parsed.success) {
        return problem(reply, 400, 'invalid-query', 'That is not a routed task id.')
      }
      const args = ['routing', 'attempts', runId, '--json']
      if (parsed.data.taskId !== undefined) args.push('--task-id', parsed.data.taskId)
      return await controllerJson(config, reply, args,
        (raw) => routingAttemptsSchema.parse(raw))
    },
  )

  /**
   * Change one routed decision, on the record.
   *
   * Raising a tier, an effort or an account is a change to what was approved,
   * so the controller asks for a typed phrase. This server never invents that
   * phrase: it forwards `--approve` only when the confirmation it was given
   * matches exactly, and it always closes the controller's stdin so an
   * unconfirmed escalation is refused rather than left waiting for an answer
   * nobody is there to type.
   */
  app.post<{ Params: { runId: string } }>(
    '/api/runs/:runId/routing/override',
    async (request, reply) => {
      const { runId } = request.params
      if (badRunId(runId)) return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
      const parsed = overrideBody.safeParse(request.body)
      if (!parsed.success) {
        return problem(reply, 400, 'invalid-body', 'That override cannot be recorded as described.',
          describeZod(parsed.error))
      }
      const body = parsed.data
      if (body.model === undefined && body.effort === undefined && body.account === undefined) {
        return problem(reply, 400, 'invalid-body',
          'An override needs a model, an effort or an account to change.')
      }
      if (body.account !== undefined && !services.accounts.getConfigured(body.account)) {
        return problem(reply, 400, 'unknown-account', 'That is not a configured account.')
      }
      const expected = `APPROVE ROUTING ${runId}`
      const confirmed = body.confirmation !== undefined && body.confirmation.trim() === expected
      const release = services.locks.tryAcquire(`run:${runId}`)
      if (release === null) {
        return problem(reply, 409, 'busy', 'This run is being changed right now.')
      }
      try {
        const args = ['routing', 'override', runId]
        if (body.orchestrator) args.push('--orchestrator')
        else args.push('--task-id', body.taskId as string)
        if (body.model !== undefined) args.push('--model', body.model)
        if (body.effort !== undefined) args.push('--effort', body.effort)
        if (body.account !== undefined) args.push('--account', body.account)
        args.push('--reason', body.reason)
        if (confirmed) args.push('--approve')
        args.push('--json')
        const raw = await runControllerWithStdin(config, args, Readable.from([]), 1024)
        services.watcher.touch()
        return routingOverrideSchema.parse(raw)
      } catch (error) {
        if (error instanceof ControllerError) {
          if (error.status === 409 && !confirmed) {
            return problem(reply, 409, 'routing-confirmation-required',
              'Raising a model tier, an effort or an account is a change to what was approved.',
              `Type exactly: ${expected}`)
          }
          return routingProblem(reply, error)
        }
        throw error
      } finally {
        release()
      }
    },
  )

  /** Read-only aggregate reporting. It changes no policy and never could. */
  app.get('/api/routing/report', async (request, reply) => {
    const parsed = reportQuery.safeParse(request.query)
    if (!parsed.success) {
      return problem(reply, 400, 'invalid-query', 'Unusable report filters.',
        describeZod(parsed.error))
    }
    const args = ['routing', 'report', '--json']
    if (parsed.data.projectId !== undefined) args.push('--project', parsed.data.projectId)
    if (parsed.data.since !== undefined) args.push('--since', parsed.data.since)
    if (parsed.data.minSample !== undefined) {
      args.push('--min-sample', String(parsed.data.minSample))
    }
    return await controllerJson(config, reply, args,
      (raw) => routingReportSchema.parse(raw))
  })
}
