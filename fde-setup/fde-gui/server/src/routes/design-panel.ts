import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { problem } from '../problem'
import { RUN_ID_PATTERN } from '../services/controller'
import { PanelBusy, PanelUnavailable } from '../services/design-panel'
import { EFFORTS, MODEL_PATTERN } from '../services/accounts'
import {
  PANEL_MODES,
  PANEL_OUTPUT_TARGETS,
} from '../schemas/design-panel'
import { block, describeZod } from '../schemas/input'
import type { Services } from '../services/types'

/**
 * The design-panel API.
 *
 * The browser may pick only from what this server offered it: an account id, a
 * model, an effort, a lens id, a reference id, a pack id and a dial inside its
 * own range. It cannot name an executable, a flag, an environment variable, an
 * output path, a URL or a command, and every answer from the controller is
 * validated against a pinned schema before it is passed on.
 */

const PARTICIPANT_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/
const ACCOUNT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/
const REFERENCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const PACK_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const LENS_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

const participantBody = z.object({
  accountId: z.string().regex(ACCOUNT_ID_PATTERN, 'not a configured account'),
  model: z.string().regex(MODEL_PATTERN).default('default'),
  effort: z.enum(EFFORTS).default('auto'),
  lensId: z.string().regex(LENS_ID_PATTERN, 'not a known design lens'),
  lens: block(4000).optional(),
})

const createBody = z.object({
  brief: block(20000).transform((value) => value.trim()).pipe(
    z.string().min(1, 'a design panel needs a design brief')),
  participants: z.array(participantBody).min(2, 'a panel needs two or three accounts')
    .max(3, 'a panel takes at most three accounts'),
  mode: z.enum(PANEL_MODES).default('independent'),
  outputTarget: z.enum(PANEL_OUTPUT_TARGETS).default('recommendation'),
  attachmentIds: z.array(z.string().regex(ATTACHMENT_ID_PATTERN)).max(12).default([]),
  includeProductMd: z.boolean().default(false),
  includeDesignMd: z.boolean().default(false),
  referenceIds: z.array(z.string().regex(REFERENCE_ID_PATTERN)).max(2).default([]),
  packs: z.record(z.string().regex(PACK_ID_PATTERN), z.record(z.number().int()))
    .default({}),
  acknowledgePackConflict: z.boolean().default(false),
  proposePlan: z.boolean().default(true),
})

export function registerDesignPanelRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  const badRunId = (runId: string): boolean => !RUN_ID_PATTERN.test(runId)

  app.get('/api/design-panel/references', async () => {
    return await services.designPanels.referenceCatalog()
  })

  app.get('/api/design-panel/packs', async () => {
    return await services.designPanels.packCatalog()
  })

  app.get('/api/design-panel/lenses', async () => {
    return await services.designPanels.lensCatalog()
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/design-panel', async (request, reply) => {
    const { runId } = request.params
    if (badRunId(runId)) {
      return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
    }
    return { schemaVersion: 1, designPanel: await services.designPanels.view(runId) }
  })

  app.get<{ Params: { runId: string } }>(
    '/api/runs/:runId/design-panel/context',
    async (request, reply) => {
      const { runId } = request.params
      if (badRunId(runId)) {
        return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
      }
      return await services.designPanels.context(runId)
    },
  )

  // -- mutations -----------------------------------------------------------

  app.post<{ Params: { runId: string } }>('/api/runs/:runId/design-panel', async (request, reply) => {
    const { runId } = request.params
    if (badRunId(runId)) {
      return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
    }
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) {
      return problem(reply, 400, 'invalid-body',
        'That design panel cannot be created as described.', describeZod(parsed.error))
    }
    const input = parsed.data

    const accountIds = input.participants.map((participant) => participant.accountId)
    if (new Set(accountIds).size !== accountIds.length) {
      return problem(reply, 400, 'duplicate-account',
        'Each account may take part once. The same account twice is one opinion, not a panel.')
    }
    const lensIds = input.participants.map((participant) => participant.lensId)
    if (new Set(lensIds).size !== lensIds.length) {
      return problem(reply, 400, 'duplicate-lens', 'Each participant needs a distinct design lens.')
    }

    const accounts = await services.accounts.list()
    for (const participant of input.participants) {
      const account = accounts.find((item) => item.id === participant.accountId)
      if (account === undefined || !account.designPanelEligible) {
        return problem(reply, 400, 'ineligible-account',
          'Only configured Claude identities with the ui-ux-design capability can take part.')
      }
      if (!services.accounts.validateSelection(participant.accountId, participant.model, participant.effort)) {
        return problem(reply, 400, 'invalid-selection',
          'That model and effort combination is not available for this account.')
      }
      if (account.authState === 'login_required') {
        return problem(reply, 409, 'login-required',
          `Sign in to ${account.label} before starting a panel with it.`)
      }
      if (account.authState === 'unavailable') {
        return problem(reply, 503, 'claude-unavailable',
          `${account.label} is not available on this machine.`)
      }
    }

    const lenses = await services.designPanels.lensCatalog()
    const knownLenses = new Set(lenses.lenses.map((lens) => lens.id))
    for (const lensId of lensIds) {
      if (!knownLenses.has(lensId)) {
        return problem(reply, 400, 'unknown-lens', 'That design lens is not one this console offers.')
      }
    }

    if (input.referenceIds.length > 0) {
      const catalog = await services.designPanels.referenceCatalog()
      const known = new Set(catalog.entries.map((entry) => entry.id))
      for (const reference of input.referenceIds) {
        if (!known.has(reference)) {
          return problem(reply, 400, 'unknown-reference',
            'That design-language reference is not in the vendored catalog.')
        }
      }
      if (new Set(input.referenceIds).size !== input.referenceIds.length) {
        return problem(reply, 400, 'duplicate-reference',
          'Choose one primary reference and at most one different secondary reference.')
      }
    }

    const packCatalog = await services.designPanels.packCatalog()
    const packsById = new Map(packCatalog.packs.map((pack) => [pack.packId, pack]))
    for (const [packId, dials] of Object.entries(input.packs)) {
      const pack = packsById.get(packId)
      if (pack === undefined) {
        return problem(reply, 400, 'unknown-pack', 'That guidance pack is not vendored here.')
      }
      for (const [dialId, value] of Object.entries(dials)) {
        const dial = pack.dials.find((item) => item.id === dialId)
        if (dial === undefined) {
          return problem(reply, 400, 'unknown-dial', `${pack.label} has no '${dialId}' setting.`)
        }
        if (!Number.isInteger(value) || value < dial.min || value > dial.max) {
          return problem(reply, 400, 'invalid-dial',
            `${dial.label} must be a whole number between ${dial.min} and ${dial.max}.`)
        }
      }
    }
    const enabled = Object.keys(input.packs)
    const conflicts = enabled.flatMap((packId) =>
      (packsById.get(packId)?.conflictsWith ?? []).filter((other) => enabled.includes(other))
        .map((other) => `${packId} and ${other}`))
    if (conflicts.length > 0 && !input.acknowledgePackConflict) {
      return problem(reply, 409, 'pack-conflict',
        'Those guidance packs give conflicting stylistic direction.',
        `${conflicts[0]} disagree about visual direction. Choose one, or enable both deliberately.`)
    }

    const release = services.locks.tryAcquire(`run:${runId}`)
    if (release === null) {
      return problem(reply, 409, 'busy', 'This run is busy. Refresh and try again.')
    }
    try {
      const panel = await services.designPanels.create(runId, {
        brief: input.brief,
        participants: input.participants,
        mode: input.mode,
        outputTarget: input.outputTarget,
        attachmentIds: input.attachmentIds,
        includeProductMd: input.includeProductMd,
        includeDesignMd: input.includeDesignMd,
        referenceIds: input.referenceIds,
        packs: input.packs,
        acknowledgePackConflict: input.acknowledgePackConflict,
        proposePlan: input.proposePlan,
      })
      return await reply.status(201).send({ schemaVersion: 1, designPanel: panel })
    } finally {
      release()
    }
  })

  const participantAction = (
    action: 'start' | 'stop' | 'retry',
  ) => async (
    request: { params: { runId: string; participantId: string } },
    reply: Parameters<typeof problem>[0],
  ): Promise<unknown> => {
    const { runId, participantId } = request.params
    if (badRunId(runId)) {
      return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
    }
    if (!PARTICIPANT_ID_PATTERN.test(participantId)) {
      return problem(reply, 400, 'invalid-participant', 'That is not a valid participant id.')
    }
    const release = services.locks.tryAcquire(`panel:${runId}:${participantId}`)
    if (release === null) {
      return problem(reply, 409, 'busy', 'That participant is being changed right now.')
    }
    try {
      const panel = action === 'start'
        ? await services.designPanels.startParticipant(runId, participantId)
        : action === 'stop'
          ? await services.designPanels.stopParticipant(runId, participantId)
          : await services.designPanels.retryParticipant(runId, participantId)
      return { schemaVersion: 1, designPanel: panel }
    } catch (error) {
      if (error instanceof PanelBusy) {
        return problem(reply, 409, 'panel-busy', error.message)
      }
      if (error instanceof PanelUnavailable) {
        return problem(reply, 503, 'claude-unavailable', error.message)
      }
      throw error
    } finally {
      release()
    }
  }

  app.post<{ Params: { runId: string; participantId: string } }>(
    '/api/runs/:runId/design-panel/participants/:participantId/start',
    participantAction('start'),
  )
  app.post<{ Params: { runId: string; participantId: string } }>(
    '/api/runs/:runId/design-panel/participants/:participantId/stop',
    participantAction('stop'),
  )
  app.post<{ Params: { runId: string; participantId: string } }>(
    '/api/runs/:runId/design-panel/participants/:participantId/retry',
    participantAction('retry'),
  )

  app.post<{ Params: { runId: string } }>(
    '/api/runs/:runId/design-panel/reconcile',
    async (request, reply) => {
      const { runId } = request.params
      if (badRunId(runId)) {
        return problem(reply, 400, 'invalid-run-id', 'That is not a valid run id.')
      }
      const release = services.locks.tryAcquire(`panel:${runId}:reconciliation`)
      if (release === null) {
        return problem(reply, 409, 'busy', 'This panel is being changed right now.')
      }
      try {
        return { schemaVersion: 1, designPanel: await services.designPanels.reconcile(runId) }
      } catch (error) {
        if (error instanceof PanelBusy) {
          return problem(reply, 409, 'panel-busy', error.message)
        }
        if (error instanceof PanelUnavailable) {
          return problem(reply, 503, 'claude-unavailable', error.message)
        }
        throw error
      } finally {
        release()
      }
    },
  )
}
