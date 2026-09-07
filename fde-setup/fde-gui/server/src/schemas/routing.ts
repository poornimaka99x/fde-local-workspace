import { z } from 'zod'

/**
 * The routing contracts, validated at the boundary.
 *
 * Same two jobs as the rest of `schemas/`: structure the UI dereferences is
 * guaranteed, individual scalars are tolerated. A newer controller may add
 * fields; this console keeps working. A controller that answers a shape the
 * page would crash on is refused instead.
 *
 * `schemaVersion` is pinned to 1. It is bumped when a field changes meaning,
 * not when one is added.
 */
const SCHEMA_VERSION = z.literal(1)
const loose = z.object({}).passthrough()

export const TIERS = ['economy', 'standard', 'premium'] as const
export const BANDS = ['simple', 'standard', 'complex', 'critical'] as const
export const FLOORS = ['low', 'standard', 'high', 'critical'] as const
export const STRATEGIES = ['balanced', 'quality_first', 'cost_first'] as const
export const ROUTING_MODES = ['auto', 'manual'] as const
export const CONFIDENCES = ['high', 'medium', 'low'] as const

/**
 * A telemetry figure with its provenance attached.
 *
 * The state is what makes this readable: a value that is missing is
 * `unavailable` with a reason and no number, and the page must render that as
 * "unavailable" rather than as zero. Anything that arrives without a
 * recognisable state is treated as unavailable, which is the safe reading.
 */
export const usageValueSchema = z
  .object({
    state: z.enum(['reported', 'estimated', 'unavailable']).catch('unavailable'),
    value: z.union([z.number(), z.string(), z.null()]).nullish(),
    source: z.string().nullish(),
    reason: z.string().nullish(),
  })
  .passthrough()

export const usageRollupSchema = z.record(usageValueSchema).default({})

const escalationCeilingSchema = z
  .object({
    tier: z.string().nullish(),
    effort: z.string().nullish(),
    maxRetries: z.number().nullish(),
    rungsAbove: z.number().nullish(),
    requiresRecordedFailureAbove: loose.nullish(),
  })
  .passthrough()
  .nullish()

const dimensionSchema = z
  .object({
    id: z.string(),
    label: z.string().default(''),
    score: z.number().default(0),
    evidence: z.string().default(''),
  })
  .passthrough()

const riskFlagSchema = z
  .object({
    flag: z.string(),
    floor: z.string().nullish(),
    evidence: z.string().default(''),
  })
  .passthrough()

export const assessmentSchema = z
  .object({
    score: z.number().default(0),
    maxScore: z.number().default(0),
    band: z.string().default('standard'),
    bandFromScore: z.string().nullish(),
    dimensions: z.array(dimensionSchema).default([]),
    confidence: z.string().default('medium'),
    riskFlags: z.array(riskFlagSchema).default([]),
    qualityFloor: z.string().default('standard'),
    riskFloor: z.string().nullish(),
    strictestStageFloor: z.string().nullish(),
    overrides: z.array(z.string()).default([]),
    missingInformation: z.array(z.string()).default([]),
    clarification: z.string().nullish(),
    signals: loose.nullish(),
  })
  .passthrough()

const alternativeSchema = z
  .object({
    model: z.string(),
    effort: z.string().default(''),
    tier: z.string().default(''),
    costUnits: z.number().nullish(),
    expectedCostUnits: z.number().nullish(),
  })
  .passthrough()

const rejectedSchema = z
  .object({
    model: z.string(),
    effort: z.string().default(''),
    tier: z.string().default(''),
    reason: z.string().default(''),
  })
  .passthrough()

export const orchestratorDecisionSchema = z
  .object({
    accountId: z.string().nullish(),
    account: z.string().nullish(),
    accountLabel: z.string().nullish(),
    accountAvailable: z.boolean().nullish(),
    provider: z.string().nullish(),
    routable: z.boolean().default(false),
    model: z.string().nullish(),
    modelLabel: z.string().nullish(),
    effort: z.string().nullish(),
    tier: z.string().nullish(),
    qualityFloor: z.string().nullish(),
    costUnits: z.number().nullish(),
    expectedCostUnits: z.number().nullish(),
    estimatedCostUnits: z.number().nullish(),
    retryProbability: z.number().nullish(),
    reason: z.string().default(''),
    strategyRule: z.string().nullish(),
    limitations: z.array(z.string()).default([]),
    escalationCeiling: escalationCeilingSchema,
    alternatives: z.array(alternativeSchema).default([]),
    rejected: z.array(rejectedSchema).default([]),
    overridden: z.boolean().nullish(),
  })
  .passthrough()

export const progressSchema = z
  .object({
    taskId: z.string().nullish(),
    attempts: z.number().default(0),
    retries: z.number().default(0),
    escalations: z.number().default(0),
    attemptsAtCurrentRung: z.number().default(0),
    lastOutcome: z.string().nullish(),
    lastClassification: z.string().nullish(),
    lastModel: z.string().nullish(),
    lastEffort: z.string().nullish(),
    spentCostUnits: z.number().default(0),
    maxRetries: z.number().nullish(),
  })
  .passthrough()

export const independenceSchema = z
  .object({
    independent: z.boolean().default(false),
    of: z.array(z.string()).default([]),
    reason: z.string().default(''),
    requiresDegradedApproval: z.boolean().default(false),
  })
  .passthrough()
  .nullish()

/**
 * One row of the execution matrix.
 *
 * Account identity, specialist method, model and effort are four separate
 * fields because they are four separate things, and a reader who conflates them
 * ends up believing an independent check happened because three rows appeared.
 */
export const routedTaskSchema = z
  .object({
    taskId: z.string(),
    stage: z.string().default(''),
    stageLabel: z.string().nullish(),
    objective: z.string().nullish(),
    requiredRole: z.string().default(''),
    roleLabel: z.string().nullish(),
    specialist: z.string().nullish(),
    specialistReason: z.string().nullish(),
    reason: z.string().nullish(),
    discretionary: z.boolean().nullish(),
    accountId: z.string().nullish(),
    accountLabel: z.string().nullish(),
    accountAvailable: z.boolean().nullish(),
    provider: z.string().nullish(),
    routable: z.boolean().default(false),
    model: z.string().nullish(),
    effort: z.string().nullish(),
    tier: z.string().nullish(),
    qualityFloor: z.string().nullish(),
    band: z.string().nullish(),
    dependsOn: z.array(z.string()).default([]),
    parallelizable: z.boolean().default(false),
    estimatedCostUnits: z.number().nullish(),
    costUnits: z.number().nullish(),
    escalationCeiling: escalationCeilingSchema,
    strategyRule: z.string().nullish(),
    alternatives: z.array(alternativeSchema).default([]),
    rejected: z.array(rejectedSchema).default([]),
    independence: independenceSchema,
    progress: progressSchema.nullish(),
    overridden: z.boolean().nullish(),
  })
  .passthrough()

export const limitsSchema = z
  .object({
    maxSpecialists: z.number().nullish(),
    maxSpecialistsPerStage: z.number().nullish(),
    maxParallel: z.number().nullish(),
    maxRetries: z.number().nullish(),
    maxCostUnits: z.number().nullish(),
    maxAutomaticTier: z.string().nullish(),
    maxAutomaticEffort: z.string().nullish(),
    requireIndependentReview: z.boolean().nullish(),
  })
  .passthrough()

const notScheduledSchema = z
  .object({
    stage: z.string().nullish(),
    role: z.string().nullish(),
    reason: z.string().default(''),
  })
  .passthrough()

const overrideEntrySchema = z
  .object({
    at: z.string().nullish(),
    operator: z.string().nullish(),
    target: z.string().default(''),
    field: z.string().default(''),
    from: z.union([z.string(), z.number(), z.null()]).nullish(),
    to: z.union([z.string(), z.number(), z.null()]).nullish(),
    reason: z.string().default(''),
    escalation: z.boolean().default(false),
    previousDecisionHash: z.string().nullish(),
    decisionHash: z.string().nullish(),
  })
  .passthrough()

const supersededSchema = z
  .object({
    approvedAt: z.string().nullish(),
    approvedBy: z.string().nullish(),
    approvedWithPlanHash: z.string().nullish(),
    decisionHash: z.string().nullish(),
    supersededAt: z.string().nullish(),
    reason: z.string().default(''),
  })
  .passthrough()

/** A full routing decision, as `routing preview` and `routing show` return it. */
export const routingDecisionSchema = z
  .object({
    schemaVersion: SCHEMA_VERSION,
    policyRevision: z.string().default(''),
    mode: z.string().default('auto'),
    strategy: z.string().default('balanced'),
    assessment: assessmentSchema,
    effectiveBand: z.string().nullish(),
    limitBand: z.string().nullish(),
    orchestrator: orchestratorDecisionSchema,
    tasks: z.array(routedTaskSchema).default([]),
    limits: limitsSchema,
    estimatedCostUnits: z.number().default(0),
    costUnitsAreEstimates: z.boolean().default(true),
    notScheduled: z.array(notScheduledSchema).default([]),
    unroutable: z.array(loose).default([]),
    warnings: z.array(z.string()).default([]),
    specialistCount: z.number().nullish(),
    discretionaryCount: z.number().nullish(),
    maxObservedParallel: z.number().nullish(),
    decisionHash: z.string().default(''),
    proposedAt: z.string().nullish(),
    approvedAt: z.string().nullish(),
    approvedBy: z.string().nullish(),
    approvedWithPlanHash: z.string().nullish(),
    planHash: z.string().nullish(),
    overrides: z.array(overrideEntrySchema).default([]),
    supersededApprovals: z.array(supersededSchema).default([]),
    provisional: z.boolean().nullish(),
    provisionalReason: z.string().nullish(),
  })
  .passthrough()

export const routingPreviewSchema = z
  .object({
    schemaVersion: SCHEMA_VERSION,
    preview: routingDecisionSchema,
  })
  .passthrough()

/** The bounded summary `status --json` carries, and `routing show` repeats. */
export const routingSummarySchema = z
  .object({
    present: z.boolean().default(true),
    readable: z.boolean().default(true),
    error: z.string().nullish(),
    message: z.string().nullish(),
    schemaVersion: z.number().nullish(),
    policyRevision: z.string().nullish(),
    mode: z.string().nullish(),
    strategy: z.string().nullish(),
    band: z.string().nullish(),
    score: z.number().nullish(),
    maxScore: z.number().nullish(),
    confidence: z.string().nullish(),
    qualityFloor: z.string().nullish(),
    riskFlags: z.array(z.string()).default([]),
    clarification: z.string().nullish(),
    missingInformation: z.array(z.string()).default([]),
    orchestrator: loose.nullish(),
    taskCount: z.number().nullish(),
    specialistCount: z.number().nullish(),
    tasks: z.array(routedTaskSchema).default([]),
    tasksTruncated: z.boolean().nullish(),
    limits: limitsSchema.nullish(),
    estimatedCostUnits: z.number().nullish(),
    spentCostUnits: z.number().nullish(),
    costUnitsAreEstimates: z.boolean().nullish(),
    usage: usageRollupSchema,
    approved: z.boolean().default(false),
    approvedAt: z.string().nullish(),
    proposedAt: z.string().nullish(),
    decisionHash: z.string().nullish(),
    approvedWithPlanHash: z.string().nullish(),
    planHashMatches: z.boolean().nullish(),
    overrideCount: z.number().nullish(),
    notScheduled: z.array(notScheduledSchema).default([]),
    unroutable: z.array(loose).default([]),
    warnings: z.array(z.string()).default([]),
  })
  .passthrough()

export const routingShowSchema = z
  .object({
    schemaVersion: SCHEMA_VERSION,
    runId: z.string(),
    routing: routingDecisionSchema,
    summary: routingSummarySchema.nullish(),
  })
  .passthrough()

export const routingExplainSchema = z
  .object({
    schemaVersion: SCHEMA_VERSION,
    runId: z.string(),
    policyRevision: z.string().nullish(),
    policyRevisionOnDisk: z.string().nullish(),
    policyDrift: z.string().nullish(),
    strategy: z.string().nullish(),
    strategyRule: z.string().nullish(),
    assessment: assessmentSchema,
    target: z
      .object({
        taskId: z.string().nullish(),
        stage: z.string().nullish(),
        requiredRole: z.string().nullish(),
        specialist: z.string().nullish(),
        specialistReason: z.string().nullish(),
        accountId: z.string().nullish(),
        model: z.string().nullish(),
        effort: z.string().nullish(),
        tier: z.string().nullish(),
        qualityFloor: z.string().nullish(),
        reason: z.string().nullish(),
        limitations: z.array(z.string()).default([]),
        estimatedCostUnits: z.number().nullish(),
        escalationCeiling: escalationCeilingSchema,
        independence: independenceSchema,
      })
      .passthrough(),
    alternativesConsidered: z.array(alternativeSchema).default([]),
    rejected: z.array(rejectedSchema).default([]),
    limits: limitsSchema.nullish(),
    notScheduled: z.array(notScheduledSchema).default([]),
    costUnitsAreEstimates: z.boolean().nullish(),
  })
  .passthrough()

const attemptSchema = z
  .object({
    at: z.string().nullish(),
    taskId: z.string().nullish(),
    attempt: z.number().nullish(),
    mode: z.string().nullish(),
    stage: z.string().nullish(),
    requiredRole: z.string().nullish(),
    specialist: z.string().nullish(),
    accountId: z.string().nullish(),
    model: z.string().nullish(),
    effort: z.string().nullish(),
    tier: z.string().nullish(),
    qualityFloor: z.string().nullish(),
    estimatedCostUnits: z.number().nullish(),
    outcome: z.string().nullish(),
    classification: z.string().nullish(),
    exit: z.number().nullish(),
    artifact: z.string().nullish(),
    reason: z.string().nullish(),
    usage: z.record(usageValueSchema).default({}),
    notes: z.array(z.string()).default([]),
    evidence: z.array(z.string()).default([]),
    supersedes: loose.nullish(),
    recordedBy: z.string().nullish(),
  })
  .passthrough()

export const routingAttemptsSchema = z
  .object({
    schemaVersion: SCHEMA_VERSION,
    runId: z.string(),
    attempts: z.array(attemptSchema).default([]),
    ledger: z.array(attemptSchema).default([]),
    progress: z.array(progressSchema).default([]),
    spentCostUnits: z.number().default(0),
    approvedCostUnits: z.number().nullish(),
    costUnitsAreEstimates: z.boolean().nullish(),
    usage: usageRollupSchema,
  })
  .passthrough()

export const routingOverrideSchema = z
  .object({
    schemaVersion: SCHEMA_VERSION,
    runId: z.string(),
    target: z.string(),
    changes: z
      .array(
        z
          .object({
            field: z.string(),
            from: z.union([z.string(), z.number(), z.null()]).nullish(),
            to: z.union([z.string(), z.number(), z.null()]).nullish(),
          })
          .passthrough(),
      )
      .default([]),
    decisionHash: z.string().nullish(),
    previousDecisionHash: z.string().nullish(),
    estimatedCostUnits: z.number().nullish(),
    warnings: z.array(z.string()).default([]),
  })
  .passthrough()

const recommendationSchema = z
  .object({
    id: z.string(),
    observation: z.string().default(''),
    recommendation: z.string().default(''),
    sampleSize: z.number().default(0),
    confidence: z.string().default('low'),
    appliesTo: z.string().default(''),
    evidence: z.array(z.string()).default([]),
    applied: z.boolean().default(false),
    note: z.string().default(''),
  })
  .passthrough()

export const routingReportSchema = z
  .object({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: z.string().nullish(),
    policyRevision: z.string().nullish(),
    scope: loose,
    runs: loose,
    attempts: loose,
    cost: loose,
    calibration: z
      .object({
        minSample: z.number().default(5),
        recommendations: z.array(recommendationSchema).default([]),
        insufficientEvidence: z.array(loose).default([]),
        policyChanged: z.literal(false),
        note: z.string().default(''),
      })
      .passthrough(),
  })
  .passthrough()

/**
 * What the controller says it can be asked, from `fde version --json`.
 *
 * The console feature-detects on `capabilities` rather than guessing from a
 * version number, and `routingPolicy.state` tells it whether automatic routing
 * is usable at all — which it says even when the policy on disk is broken.
 */
export const routingPolicySchema = z
  .object({
    schemaVersion: z.number().nullish(),
    toolkit: z.string().nullish(),
    contracts: z.array(z.string()).default([]),
    capabilities: z.array(z.string()).default([]),
    routingPolicy: z
      .object({
        state: z.enum(['available', 'unavailable']).catch('unavailable'),
        code: z.string().nullish(),
        message: z.string().nullish(),
        policyRevision: z.string().nullish(),
        schemaVersion: z.number().nullish(),
        strategies: z.array(z.string()).default([]),
        providers: z.array(z.string()).default([]),
        costUnitsAreEstimates: z.boolean().nullish(),
        monetaryPricing: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough()

export type RoutingDecision = z.infer<typeof routingDecisionSchema>
export type RoutingSummary = z.infer<typeof routingSummarySchema>
export type RoutedTask = z.infer<typeof routedTaskSchema>
export type RoutingExplain = z.infer<typeof routingExplainSchema>
export type RoutingAttempts = z.infer<typeof routingAttemptsSchema>
export type RoutingReport = z.infer<typeof routingReportSchema>
