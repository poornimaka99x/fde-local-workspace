import { z } from 'zod'

/**
 * The design-panel contracts, validated at the boundary like every other
 * controller answer.
 *
 * Same two rules as `schemas/controller.ts`: structure the UI dereferences must
 * be the right kind of thing or the response is refused, while individual
 * scalars fall back so one thin record degrades a row rather than a page.
 * `schemaVersion` is pinned — this console understands version 1.
 */
// Version 2 of the panel document: it carries the collaborative handoff order,
// the sealed copy of every image the panel passes through, and the prototype a
// 'prototype' panel produces. A version-1 panel cannot express any of them, so
// the controller refuses it rather than half-reading it, and so does this.
const SCHEMA_VERSION = z.literal(2)
const loose = z.object({}).passthrough()

export const PANEL_MODES = ['independent', 'collaborative'] as const
export const PANEL_OUTPUT_TARGETS = ['recommendation', 'prototype', 'design-to-code'] as const
export const PANEL_PARTICIPANT_STATES = [
  'pending', 'running', 'succeeded', 'failed', 'stopped', 'interrupted',
] as const

export const participantSchema = z
  .object({
    participantId: z.string(),
    agentId: z.string().default(''),
    profile: z.string().nullish(),
    label: z.string().default(''),
    model: z.string().default('default'),
    effort: z.string().default('auto'),
    lensId: z.string().default(''),
    lensLabel: z.string().default(''),
    lens: z.string().nullish(),
    state: z.string().default('pending'),
    attempts: z.number().default(0),
    startedAt: z.string().nullish(),
    endedAt: z.string().nullish(),
    durationMs: z.number().nullish(),
    error: z.string().nullish(),
    proposalPath: z.string().nullish(),
    proposalPresent: z.boolean().default(false),
    proposalBytes: z.number().nullish(),
    prototypePath: z.string().nullish(),
    prototypePresent: z.boolean().default(false),
    commonContextSha256: z.string().nullish(),
    promptSha256: z.string().nullish(),
    /** Where this participant sits in the panel's handoff order. */
    order: z.number().default(0),
    /** Whose proposals this participant was handed before it started. */
    handoffFrom: z.array(z.string()).default([]),
    handoffSha256: z.string().nullish(),
  })
  .passthrough()

export const panelViewSchema = z
  .object({
    schemaVersion: SCHEMA_VERSION,
    runId: z.string(),
    panelId: z.string(),
    projectId: z.string().nullish(),
    state: z.string(),
    mode: z.string(),
    outputTarget: z.string(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
    brief: z.string().default(''),
    rolesConfirmed: z.boolean().default(false),
    pendingRoles: z.array(z.string()).default([]),
    designerRole: z.array(z.string()).default([]),
    runState: z.string().nullish(),
    conceptStageReady: z.boolean().default(false),
    reconcileStageReady: z.boolean().default(false),
    barrierOpenedAt: z.string().nullish(),
    degradedApprovedAt: z.string().nullish(),
    packConflictAcknowledged: z.boolean().default(false),
    packs: z.record(z.record(z.number())).default({}),
    references: z.array(z.string()).default([]),
    context: loose.default({}),
    contextManifest: loose.nullish(),
    handoffOrder: z.array(z.string()).default([]),
    mediaFiles: z
      .array(
        z
          .object({
            runPath: z.string().nullish(),
            sha256: z.string().nullish(),
            originalName: z.string().nullish(),
            mediaType: z.string().nullish(),
            bytes: z.number().nullish(),
          })
          .passthrough(),
      )
      .default([]),
    participants: z.array(participantSchema).default([]),
    succeededCount: z.number().default(0),
    reconciliation: loose.default({}),
    artifacts: z
      .array(z.object({ path: z.string(), present: z.boolean().default(false) }).passthrough())
      .default([]),
    comparisonDimensions: z.array(z.string()).default([]),
    nextAction: z.string().nullish(),
  })
  .passthrough()

export const panelEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    designPanel: panelViewSchema,
    nextAction: z.string().nullish(),
  })
  .passthrough()

export const panelContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string(),
    panelId: z.string(),
    context: loose.default({}),
    manifest: loose,
  })
  .passthrough()

/**
 * The start answer carries the exact prompt for one participant. It never
 * leaves this process: the console runs the account with it and hands the
 * answer back to the controller. It is not logged and not returned to the
 * browser.
 */
export const panelStartSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string(),
    panelId: z.string(),
    participantId: z.string(),
    agentId: z.string(),
    profile: z.string().nullish(),
    model: z.string().default('default'),
    effort: z.string().default('auto'),
    lensId: z.string().default(''),
    attempt: z.number().default(1),
    commonContextSha256: z.string(),
    promptSha256: z.string(),
    promptBytes: z.number().default(0),
    prompt: z.string(),
    /** The sealed copies, re-hashed by the controller at this start. */
    mediaPaths: z.array(z.string()).default([]),
    handoffFrom: z.array(z.string()).default([]),
    handoffSha256: z.string().nullish(),
    proposalPath: z.string().default(''),
  })
  .passthrough()

export const panelReconcileStartSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string(),
    panelId: z.string(),
    agentId: z.string(),
    profile: z.string().nullish(),
    model: z.string().default('default'),
    effort: z.string().default('auto'),
    degraded: z.boolean().default(false),
    commonContextSha256: z.string(),
    promptSha256: z.string(),
    promptBytes: z.number().default(0),
    prompt: z.string(),
  })
  .passthrough()

export const referenceCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    available: z.boolean().default(false),
    source: z.string().nullish(),
    commit: z.string().nullish(),
    license: z.string().nullish(),
    warning: z.string().nullish(),
    entries: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string().nullish(),
            description: z.string().nullish(),
            sourceUrl: z.string().nullish(),
            sha256: z.string().nullish(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough()

export const packDialSchema = z
  .object({
    id: z.string(),
    label: z.string().default(''),
    min: z.number().default(1),
    max: z.number().default(10),
    default: z.number().default(5),
    help: z.string().nullish(),
  })
  .passthrough()

export const packListSchema = z
  .object({
    schemaVersion: z.literal(1),
    packs: z
      .array(
        z
          .object({
            packId: z.string(),
            label: z.string().default(''),
            license: z.string().nullish(),
            commit: z.string().nullish(),
            sourceUrl: z.string().nullish(),
            stability: z.string().nullish(),
            stabilityNote: z.string().nullish(),
            changes: z.array(z.string()).default([]),
            conflictsWith: z.array(z.string()).default([]),
            dials: z.array(packDialSchema).default([]),
            detector: loose.nullish(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough()

export const lensListSchema = z
  .object({
    schemaVersion: z.literal(1),
    lenses: z
      .array(
        z.object({ id: z.string(), label: z.string().default(''), text: z.string().default('') })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough()

export type PanelView = z.infer<typeof panelViewSchema>
export type PanelStart = z.infer<typeof panelStartSchema>
export type PanelReconcileStart = z.infer<typeof panelReconcileStartSchema>
export type ReferenceCatalog = z.infer<typeof referenceCatalogSchema>
export type PackList = z.infer<typeof packListSchema>
export type LensList = z.infer<typeof lensListSchema>
