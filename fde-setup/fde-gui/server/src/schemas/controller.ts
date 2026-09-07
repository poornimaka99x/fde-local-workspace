import { z } from 'zod'

/**
 * The controller's JSON contracts, validated at the boundary.
 *
 * Two different jobs, and the difference matters:
 *
 *  - **Structure is guaranteed.** Anything the UI dereferences — `roles.assignments`,
 *    `artifacts.expected`, `requirement`, `events` — must arrive as the right kind
 *    of thing, or the response is refused as an unexpected shape. Passing
 *    validation and then crashing on `.map` is not validation.
 *  - **Content is tolerated.** Individual scalars fall back to defaults, so one
 *    legacy or half-written record shows as a gap in the page rather than
 *    blanking the run. Unknown fields pass through, so a newer controller does
 *    not break an older console.
 *
 * `schemaVersion` is pinned: this console understands version 1 and says so
 * rather than guessing at a shape it was not written for.
 */
const SCHEMA_VERSION = z.literal(1)
const loose = z.object({}).passthrough()

export const sessionSchema = z
  .object({
    provider: z.string().nullish(),
    profile: z.string().nullish(),
    sessionId: z.string().nullish(),
    resumable: z.boolean().default(false),
    resumeReason: z.string().nullish(),
  })
  .passthrough()

export const orchestratorSchema = z
  .object({
    agentId: z.string(),
    label: z.string().default(''),
    kind: z.string().default('unknown'),
  })
  .passthrough()
  .nullish()

export const runSummarySchema = z
  .object({
    runId: z.string(),
    dir: z.string().nullish(),
    state: z.string().nullish(),
    blockedFrom: z.string().nullish(),
    projectId: z.string().nullish(),
    requirement: z.string().nullish(),
    jiraKey: z.string().nullish(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
    orchestrator: orchestratorSchema,
    stages: z.array(z.string()).nullish(),
    planConfirmed: z.boolean().nullish(),
    session: sessionSchema,
    malformed: z.boolean().nullish(),
  })
  .passthrough()

export const runListSchema = z
  .object({
    schemaVersion: SCHEMA_VERSION,
    runs: z.array(runSummarySchema),
    warnings: z.array(z.string()).default([]),
  })
  .passthrough()

export const projectSchema = z
  .object({
    projectId: z.string(),
    name: z.string().nullish(),
    description: z.string().nullish(),
    repoPaths: z.array(z.string()).default([]),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
    runCount: z.number().nullish(),
    lastActivityAt: z.string().nullish(),
  })
  .passthrough()

export const projectListSchema = z
  .object({
    schemaVersion: SCHEMA_VERSION,
    projects: z.array(projectSchema),
    unassignedRunCount: z.number().default(0),
    warnings: z.array(z.string()).default([]),
  })
  .passthrough()

export const projectDetailSchema = z
  .object({
    schemaVersion: SCHEMA_VERSION,
    project: projectSchema,
    runs: z.array(runSummarySchema).default([]),
    events: z.array(loose).default([]),
    malformedEvents: z.array(loose).default([]),
    warnings: z.array(z.string()).default([]),
  })
  .passthrough()

export const projectDeletedSchema = z
  .object({
    schemaVersion: SCHEMA_VERSION,
    deletedProject: z
      .object({
        projectId: z.string(),
        name: z.string().nullish(),
        deletedAt: z.string(),
        recoverable: z.literal(true),
        runCount: z.literal(0),
        chatCount: z.literal(0),
      })
      .passthrough(),
  })
  .passthrough()

export const eventPageSchema = z
  .object({
    total: z.number(),
    offset: z.number(),
    limit: z.number(),
    returned: z.number(),
    nextCursor: z.number().nullable().default(null),
    items: z.array(loose).default([]),
  })
  .passthrough()

const requirementSchema = z
  .object({
    summary: z.string().nullish(),
    jiraKey: z.string().nullish(),
    hasFile: z.boolean().default(false),
    path: z.string().nullish(),
  })
  .passthrough()

const stageStepSchema = z
  .object({
    stage: z.string(),
    label: z.string().default(''),
    state: z.enum(['done', 'current', 'pending']).default('pending'),
  })
  .passthrough()

const roleRowSchema = z
  .object({
    role: z.string(),
    label: z.string().default(''),
    multi: z.boolean().default(false),
    optional: z.boolean().default(false),
    assignees: z
      .array(z.object({ agentId: z.string(), label: z.string().default('') }).passthrough())
      .default([]),
  })
  .passthrough()

const rolesSchema = z
  .object({
    confirmed: z.boolean().default(false),
    confirmedAt: z.string().nullish(),
    selectedAt: z.string().nullish(),
    orchestrator: orchestratorSchema,
    assignments: z.array(roleRowSchema).default([]),
  })
  .passthrough()

const approvalSchema = z
  .object({
    approvalId: z.string(),
    type: z.string().default('unknown'),
    status: z.string().default('malformed'),
    stage: z.string().nullish(),
    target: z.string().nullish(),
    summary: z.string().default(''),
    items: z.array(z.string()).default([]),
    issuedAt: z.string().nullish(),
    expiresAt: z.string().nullish(),
    consumed: z.boolean().default(false),
    consumedAt: z.string().nullish(),
    revoked: z.boolean().default(false),
    taskFile: z.string().nullish(),
    taskFileHash: z.string().nullish(),
    repositoryPath: z.string().nullish(),
    writableRoot: z.string().nullish(),
    network: z.boolean().default(false),
  })
  .passthrough()

const attachmentSchema = z
  .object({
    attachmentId: z.string(),
    originalName: z.string().default('(unnamed)'),
    storedName: z.string().default(''),
    relativePath: z.string().default(''),
    mediaType: z.string().default('application/octet-stream'),
    size: z.number().default(0),
    sha256: z.string().default(''),
    attachedAt: z.string().nullish(),
    source: z.string().nullish(),
  })
  .passthrough()

const artifactsSchema = z
  .object({
    expected: z
      .array(
        z
          .object({
            stage: z.string().default(''),
            path: z.string(),
            found: z.boolean().default(false),
          })
          .passthrough(),
      )
      .default([]),
    discovered: z
      .array(
        z
          .object({
            path: z.string(),
            kind: z.string().default('file'),
            size: z.number().nullish(),
            modifiedAt: z.string().nullish(),
          })
          .passthrough(),
      )
      .default([]),
    truncated: z.boolean().default(false),
  })
  .passthrough()

const hygieneSchema = z
  .object({
    status: z.string().default('unknown'),
    at: z.string().nullish(),
    mode: z.string().nullish(),
    files: z.number().nullish(),
    changedFiles: z.number().nullish(),
    wouldChangeFiles: z.number().nullish(),
    errors: z.number().nullish(),
    evidencePath: z.string().nullish(),
    evidenceSha256: z.string().nullish(),
    evidencePresent: z.boolean().default(false),
    provenancePreserved: z.boolean().default(true),
    provenanceService: z.string().nullish(),
  })
  .passthrough()

export const statusSchema = z
  .object({
    schemaVersion: SCHEMA_VERSION,
    runId: z.string(),
    dir: z.string(),
    manifest: loose,
    state: z.string().nullish(),
    blockedFrom: z.string().nullish(),
    projectId: z.string().nullish(),
    project: z
      .object({
        projectId: z.string(),
        name: z.string().nullish(),
        repoPaths: z.array(z.string()).default([]),
      })
      .passthrough()
      .nullish(),
    requirement: requirementSchema,
    plan: loose.nullish(),
    planLine: z.string().nullish(),
    stageTimeline: z.array(stageStepSchema).default([]),
    sequence: z.array(z.string()).default([]),
    nextState: z.string().nullish(),
    nextAction: z.string().nullish(),
    roles: rolesSchema,
    approvals: z.array(approvalSchema).default([]),
    checkpoints: z.array(loose).default([]),
    events: eventPageSchema,
    artifacts: artifactsSchema,
    attachments: z.array(attachmentSchema).default([]),
    outputHygiene: hygieneSchema.nullish(),
    session: sessionSchema,
    // Additive: a run without a design panel answers null, and an older
    // controller simply omits the field.
    designPanel: loose.nullish(),
    warnings: z.array(z.string()).default([]),
  })
  .passthrough()

export const attachmentListSchema = z
  .object({
    schemaVersion: SCHEMA_VERSION,
    runId: z.string(),
    attachments: z.array(attachmentSchema).default([]),
    malformed: z.array(loose).default([]),
  })
  .passthrough()

export type RunSummary = z.infer<typeof runSummarySchema>
export type RunStatus = z.infer<typeof statusSchema>
export type ProjectRecord = z.infer<typeof projectSchema>

export const runCreatedSchema = z
  .object({
    schemaVersion: z.literal(1),
    run: runSummarySchema,
    nextAction: z.string().nullish(),
  })
  .passthrough()

export const attachmentCreatedSchema = z
  .object({
    schemaVersion: z.literal(1),
    attachment: attachmentSchema,
  })
  .passthrough()
