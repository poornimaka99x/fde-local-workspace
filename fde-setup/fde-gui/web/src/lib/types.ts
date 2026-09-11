/** Mirrors of the controller contracts (schema version 1). Deliberately loose:
 *  a legacy or half-written run must still type-check its way onto the screen. */
/** What the controller derives about resuming a run. */
export interface SessionView {
  provider: string | null
  profile: string | null
  sessionId: string | null
  resumable: boolean
  resumeReason: string | null
}

export interface OrchestratorView {
  agentId: string
  label: string
  kind: string
}

export interface RunSummary {
  runId: string
  dir?: string | null
  state: string | null
  blockedFrom?: string | null
  projectId: string | null
  requirement: string | null
  jiraKey?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  orchestrator: OrchestratorView | null
  stages?: string[] | null
  planConfirmed?: boolean | null
  session: SessionView
  malformed?: boolean | null
}

export interface RunListResponse {
  schemaVersion: number
  runs: RunSummary[]
  total: number
  returned: number
  warnings: string[]
}

export interface ProjectRecord {
  projectId: string
  name: string | null
  description: string | null
  repoPaths: string[]
  createdAt?: string | null
  updatedAt?: string | null
  runCount?: number | null
  lastActivityAt?: string | null
}

export interface ProjectListResponse {
  schemaVersion: number
  projects: ProjectRecord[]
  unassignedRunCount: number
  warnings: string[]
}

export interface ProjectDetailResponse {
  schemaVersion: number
  project: ProjectRecord
  runs: RunSummary[]
  events: Record<string, unknown>[]
  malformedEvents: Record<string, unknown>[]
  warnings: string[]
}

export interface EventPage {
  total: number
  offset: number
  limit: number
  returned: number
  nextCursor: number | null
  items: Record<string, unknown>[]
}

export interface StageStep {
  stage: string
  label: string
  state: 'done' | 'current' | 'pending'
}

export interface RoleRow {
  role: string
  label: string
  multi: boolean
  optional: boolean
  assignees: { agentId: string; label: string }[]
}

export interface ApprovalRow {
  approvalId: string
  type: string
  status: string
  stage: string | null
  target: string | null
  summary: string
  items: string[]
  issuedAt: string | null
  expiresAt: string | null
  consumed: boolean
  consumedAt?: string | null
  revoked: boolean
  taskFile?: string | null
  taskFileHash?: string | null
  repositoryPath?: string | null
  writableRoot?: string | null
  network?: boolean
}

export interface AttachmentRecord {
  attachmentId: string
  originalName: string
  storedName: string
  relativePath: string
  mediaType: string
  size: number
  sha256: string
  attachedAt: string
  source?: string
}

export interface HygieneView {
  status: string
  at: string | null
  mode: string | null
  files: number | null
  changedFiles: number | null
  wouldChangeFiles: number | null
  errors: number | null
  evidencePath: string | null
  evidenceSha256: string | null
  evidencePresent: boolean
  provenancePreserved: boolean
  provenanceService: string | null
}

export interface RunStatus {
  schemaVersion: number
  runId: string
  dir: string
  manifest: Record<string, unknown>
  state: string | null
  blockedFrom: string | null
  projectId: string | null
  project: { projectId: string; name: string | null; repoPaths: string[] } | null
  requirement: { summary: string | null; jiraKey: string | null; hasFile: boolean; path: string | null }
  plan: Record<string, unknown> | null
  planLine: string | null
  stageTimeline: StageStep[]
  sequence: string[]
  nextState: string | null
  nextAction: string | null
  roles: {
    confirmed: boolean
    confirmedAt: string | null
    selectedAt: string | null
    orchestrator: OrchestratorView | null
    assignments: RoleRow[]
  }
  approvals: ApprovalRow[]
  checkpoints: Record<string, unknown>[]
  events: EventPage
  artifacts: {
    expected: { stage: string; path: string; found: boolean }[]
    discovered: { path: string; kind: string; size?: number; modifiedAt?: string }[]
    truncated: boolean
  }
  attachments: AttachmentRecord[]
  outputHygiene: HygieneView | null
  session: SessionView
  designPanel: RunDesignPanelSummary | null
  /** Null for a run that selects its model and effort manually. */
  routing: RoutingSummary | null
  warnings: string[]
}

/**
 * A telemetry figure with its provenance attached.
 *
 * The state is the point. A number the page can show is `reported` or
 * `estimated`; anything else is `unavailable` with a reason and no value, and
 * must be rendered as "unavailable" — never as zero.
 */
export interface RoutingUsageValue {
  state: 'reported' | 'estimated' | 'unavailable'
  value?: number | string | null
  source?: string | null
  reason?: string | null
}

export type RoutingUsage = Record<string, RoutingUsageValue>

export interface RoutingDimension {
  id: string
  label: string
  score: number
  evidence: string
}

export interface RoutingRiskFlag {
  flag: string
  floor?: string | null
  evidence: string
}

export interface RoutingAssessment {
  score: number
  maxScore: number
  band: string
  bandFromScore?: string | null
  dimensions: RoutingDimension[]
  confidence: string
  riskFlags: RoutingRiskFlag[]
  qualityFloor: string
  riskFloor?: string | null
  strictestStageFloor?: string | null
  overrides: string[]
  missingInformation: string[]
  clarification?: string | null
}

export interface RoutingChoice {
  model: string
  effort: string
  tier: string
  costUnits?: number | null
  expectedCostUnits?: number | null
}

export interface RoutingRejection extends RoutingChoice {
  reason: string
}

export interface RoutingEscalationCeiling {
  tier?: string | null
  effort?: string | null
  maxRetries?: number | null
  rungsAbove?: number | null
  requiresRecordedFailureAbove?: Record<string, unknown> | null
}

export interface RoutingProgress {
  taskId?: string | null
  attempts: number
  retries: number
  escalations: number
  attemptsAtCurrentRung: number
  lastOutcome?: string | null
  lastClassification?: string | null
  lastModel?: string | null
  lastEffort?: string | null
  spentCostUnits: number
  maxRetries?: number | null
}

/**
 * Whether a check is genuinely independent of whoever produced the work.
 *
 * `independent: false` with `requiresDegradedApproval: true` is a real state,
 * not a missing value: the check exists but shares the producer's account, and
 * the page has to say so in words.
 */
export interface RoutingIndependence {
  independent: boolean
  of: string[]
  reason: string
  requiresDegradedApproval: boolean
}

export interface RoutingOrchestrator {
  accountId?: string | null
  account?: string | null
  accountLabel?: string | null
  accountAvailable?: boolean | null
  provider?: string | null
  routable: boolean
  model?: string | null
  modelLabel?: string | null
  effort?: string | null
  tier?: string | null
  qualityFloor?: string | null
  costUnits?: number | null
  expectedCostUnits?: number | null
  estimatedCostUnits?: number | null
  retryProbability?: number | null
  reason: string
  strategyRule?: string | null
  limitations: string[]
  escalationCeiling?: RoutingEscalationCeiling | null
  alternatives: RoutingChoice[]
  rejected: RoutingRejection[]
  overridden?: boolean | null
}

/**
 * One row of the execution matrix.
 *
 * Account identity, specialist method, model and effort are four separate
 * fields on purpose, and the UI keeps them four separate columns.
 */
export interface RoutedTask {
  taskId: string
  stage: string
  stageLabel?: string | null
  objective?: string | null
  requiredRole: string
  roleLabel?: string | null
  specialist?: string | null
  specialistReason?: string | null
  reason?: string | null
  discretionary?: boolean | null
  accountId?: string | null
  accountLabel?: string | null
  accountAvailable?: boolean | null
  provider?: string | null
  routable: boolean
  model?: string | null
  effort?: string | null
  tier?: string | null
  qualityFloor?: string | null
  band?: string | null
  dependsOn: string[]
  parallelizable: boolean
  estimatedCostUnits?: number | null
  costUnits?: number | null
  escalationCeiling?: RoutingEscalationCeiling | null
  strategyRule?: string | null
  alternatives: RoutingChoice[]
  rejected: RoutingRejection[]
  independence?: RoutingIndependence | null
  progress?: RoutingProgress | null
  overridden?: boolean | null
}

export interface RoutingLimits {
  maxSpecialists?: number | null
  maxSpecialistsPerStage?: number | null
  maxParallel?: number | null
  maxRetries?: number | null
  maxCostUnits?: number | null
  maxAutomaticTier?: string | null
  maxAutomaticEffort?: string | null
  requireIndependentReview?: boolean | null
}

export interface RoutingNotScheduled {
  stage?: string | null
  role?: string | null
  reason: string
}

export interface RoutingOverrideEntry {
  at?: string | null
  operator?: string | null
  target: string
  field: string
  from?: string | number | null
  to?: string | number | null
  reason: string
  escalation: boolean
  previousDecisionHash?: string | null
  decisionHash?: string | null
}

export interface RoutingSupersededApproval {
  approvedAt?: string | null
  approvedBy?: string | null
  approvedWithPlanHash?: string | null
  decisionHash?: string | null
  supersededAt?: string | null
  reason: string
}

export interface RoutingDecision {
  schemaVersion: number
  policyRevision: string
  mode: string
  strategy: string
  assessment: RoutingAssessment
  effectiveBand?: string | null
  limitBand?: string | null
  orchestrator: RoutingOrchestrator
  tasks: RoutedTask[]
  limits: RoutingLimits
  estimatedCostUnits: number
  costUnitsAreEstimates: boolean
  notScheduled: RoutingNotScheduled[]
  unroutable: Record<string, unknown>[]
  warnings: string[]
  specialistCount?: number | null
  discretionaryCount?: number | null
  maxObservedParallel?: number | null
  decisionHash: string
  proposedAt?: string | null
  approvedAt?: string | null
  approvedBy?: string | null
  approvedWithPlanHash?: string | null
  planHash?: string | null
  overrides: RoutingOverrideEntry[]
  supersededApprovals: RoutingSupersededApproval[]
  provisional?: boolean | null
  provisionalReason?: string | null
}

export interface RoutingPreviewResponse {
  schemaVersion: number
  preview: RoutingDecision
}

/** The bounded summary `GET /api/runs/:runId` carries. */
export interface RoutingSummary {
  present: boolean
  readable: boolean
  error?: string | null
  message?: string | null
  policyRevision?: string | null
  mode?: string | null
  strategy?: string | null
  band?: string | null
  score?: number | null
  maxScore?: number | null
  confidence?: string | null
  qualityFloor?: string | null
  riskFlags: string[]
  clarification?: string | null
  missingInformation: string[]
  orchestrator?: Record<string, unknown> | null
  taskCount?: number | null
  specialistCount?: number | null
  tasks: RoutedTask[]
  tasksTruncated?: boolean | null
  limits?: RoutingLimits | null
  estimatedCostUnits?: number | null
  spentCostUnits?: number | null
  costUnitsAreEstimates?: boolean | null
  usage: RoutingUsage
  approved: boolean
  approvedAt?: string | null
  proposedAt?: string | null
  decisionHash?: string | null
  approvedWithPlanHash?: string | null
  planHashMatches?: boolean | null
  overrideCount?: number | null
  notScheduled: RoutingNotScheduled[]
  unroutable: Record<string, unknown>[]
  warnings: string[]
}

export interface RoutingShowResponse {
  schemaVersion: number
  runId: string
  routing: RoutingDecision
  summary: RoutingSummary | null
}

export interface RoutingExplainResponse {
  schemaVersion: number
  runId: string
  policyRevision?: string | null
  policyRevisionOnDisk?: string | null
  policyDrift?: string | null
  strategy?: string | null
  strategyRule?: string | null
  assessment: RoutingAssessment
  target: {
    taskId?: string | null
    stage?: string | null
    requiredRole?: string | null
    specialist?: string | null
    specialistReason?: string | null
    accountId?: string | null
    model?: string | null
    effort?: string | null
    tier?: string | null
    qualityFloor?: string | null
    reason?: string | null
    limitations: string[]
    estimatedCostUnits?: number | null
    escalationCeiling?: RoutingEscalationCeiling | null
    independence?: RoutingIndependence | null
  }
  alternativesConsidered: RoutingChoice[]
  rejected: RoutingRejection[]
  limits?: RoutingLimits | null
  notScheduled: RoutingNotScheduled[]
  costUnitsAreEstimates?: boolean | null
}

export interface RoutingAttempt {
  at?: string | null
  taskId?: string | null
  attempt?: number | null
  mode?: string | null
  stage?: string | null
  model?: string | null
  effort?: string | null
  tier?: string | null
  estimatedCostUnits?: number | null
  outcome?: string | null
  classification?: string | null
  exit?: number | null
  artifact?: string | null
  usage: RoutingUsage
  notes: string[]
  evidence: string[]
  supersedes?: Record<string, unknown> | null
  recordedBy?: string | null
}

export interface RoutingAttemptsResponse {
  schemaVersion: number
  runId: string
  attempts: RoutingAttempt[]
  ledger: RoutingAttempt[]
  progress: RoutingProgress[]
  spentCostUnits: number
  approvedCostUnits?: number | null
  costUnitsAreEstimates?: boolean | null
  usage: RoutingUsage
}

export interface RoutingPolicyResponse {
  capabilities: string[]
  contracts: string[]
  policy: {
    state: 'available' | 'unavailable'
    code?: string | null
    message?: string | null
    policyRevision?: string | null
    strategies?: string[]
    providers?: string[]
    costUnitsAreEstimates?: boolean | null
    monetaryPricing?: string | null
  }
  previewMinRequirementChars: number
  strategies: string[]
}

export interface RunDesignPanelSummary {
  schemaVersion?: number
  readable?: boolean
  panelId: string | null
  state: string | null
  mode?: string
  outputTarget?: string
  contextSha256?: string | null
  succeededCount?: number
  participants?: { participantId: string; label: string; state: string }[]
}

export interface RunFileEntry {
  path: string
  name: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  size: number | null
  modifiedAt: string | null
  mediaType: string
  preview: 'text' | 'markdown' | 'json' | 'image' | 'pdf' | 'none'
  downloadable: boolean
}

export interface FileListResponse {
  runId: string
  entries: RunFileEntry[]
  truncated: boolean
  withheld: string[]
}

export interface ContractCheck {
  ok: boolean
  schemaVersion: number | null
  contracts: string[]
  problem: string | null
  detail: string | null
}

export interface HealthResponse {
  status: string
  version: string
  apiVersion: number
  startedAt: string
  mode: string
  controller: ContractCheck
  roots: { shared: string; runs: string; projects: string; chats: string; profiles: string }
  binaries: Record<string, { path: string; present: boolean }>
  claudeProfiles: { name: string; path: string }[]
}

export interface ConsoleSession {
  runId: string
  status: 'running' | 'exited'
  pid: number
  startedAt: string
  exitedAt: string | null
  exitCode: number | null
  cwd: string
  command: string[]
  envKeys: string[]
  stopRequestedAt: string | null
  attachedClients: number
}

export interface SessionState {
  available: boolean
  session: ConsoleSession | null
}

export interface SessionListResponse {
  available: boolean
  sessions: ConsoleSession[]
}

export type ClaudeEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export interface ClaudeModelOption {
  id: string
  label: string
  efforts: ClaudeEffort[]
}

export interface ClaudeAccount {
  id: string
  label: string
  profile: string
  provider: 'anthropic' | 'bedrock' | 'codex' | 'gemini'
  profilePresent: boolean
  authState: 'authenticated' | 'login_required' | 'external' | 'unavailable'
  authMethod: string | null
  /** Why the state is what it is, when that is not obvious. Older servers omit it. */
  authDetail?: string | null
  models: ClaudeModelOption[]
  capabilities: string[]
  /** Optional only for compatibility with servers predating role-aware account lists. */
  orchestratorEligible?: boolean
  designPanelEligible: boolean
}

export interface ClaudeAccountsResponse {
  accounts: ClaudeAccount[]
}

export type CapabilityState = 'inherit' | 'enabled' | 'disabled'

export interface FdeStageConfiguration {
  id: string
  label: string
  enabled: boolean
  primaryAccount: string | null
  reviewerAccount: string | null
  approvalRequired: true
  capabilityOverrides: Record<string, CapabilityState>
}

export interface FdeSystemConfiguration {
  schemaVersion: 1
  id: string
  version: number
  systemType: 'forward-deployed-engineer'
  executorType: 'forward-deployed-engineer'
  name: string
  description: string
  enabled: boolean
  projectId: string | null
  repository: string | null
  workspace: string | null
  artifactRoot: string
  orchestrator: string
  reviewer: string | null
  routing: 'auto' | 'manual'
  strategy: 'balanced' | 'quality_first' | 'cost_first'
  model: string
  effort: Exclude<ClaudeEffort, 'ultra'>
  stages: FdeStageConfiguration[]
  governance: {
    approvalAfterEveryStage: true
    approvalBeforeCodeChanges: true
    approvalBeforeDeployment: true
    approvalBeforeProductionMutation: true
    stopOnAmbiguity: true
  }
  createdAt: string
  updatedAt: string
}

export interface SystemTypeDefinition {
  id: 'forward-deployed-engineer'
  name: string
  shortName: string
  description: string
  executorType: 'forward-deployed-engineer'
  lifecycle: { id: string; label: string; controllerStages: readonly string[] }[]
}

export interface FdeRunRegistration {
  schemaVersion: 1
  runId: string
  systemType: 'forward-deployed-engineer'
  executorType: 'forward-deployed-engineer'
  configurationId: string
  configurationVersion: number
  configurationSnapshot: FdeSystemConfiguration
  businessIntent: string
  createdAt: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export interface ChatAttachment {
  id: string
  path: string
  kind: 'file' | 'directory'
  addedAt: string
}

export interface ChatRecord {
  schemaVersion: 1
  chatId: string
  title: string
  accountId: string
  profile: string
  provider: 'anthropic' | 'bedrock' | 'codex' | 'gemini'
  model: string
  effort: ClaudeEffort
  projectId: string | null
  cwd: string
  claudeSessionId: string
  createdAt: string
  updatedAt: string
  status: 'idle' | 'running' | 'failed'
  lastError: string | null
  messages: ChatMessage[]
  attachments: ChatAttachment[]
  serviceConnectionIds: string[]
}

export interface ChatSummary extends Omit<ChatRecord, 'messages'> {
  messageCount: number
  lastMessage: string | null
}

export interface FsEntry {
  name: string
  path: string
  kind: 'directory' | 'file' | 'other'
  symlink: boolean
  size: number | null
  modifiedAt: string | null
}

export interface FsBrowseResponse {
  path: string
  parent: string | null
  entries: FsEntry[]
  truncated: boolean
}

// -- design panel -----------------------------------------------------------

export type PanelParticipantState =
  | 'pending' | 'running' | 'succeeded' | 'failed' | 'stopped' | 'interrupted'

export interface PanelParticipant {
  participantId: string
  agentId: string
  profile: string | null
  label: string
  model: string
  effort: string
  lensId: string
  lensLabel: string
  lens: string | null
  state: PanelParticipantState | string
  attempts: number
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  error: string | null
  proposalPath: string | null
  proposalPresent: boolean
  proposalBytes: number | null
  prototypePath: string | null
  prototypePresent: boolean
  commonContextSha256: string | null
  promptSha256: string | null
  /** Where this participant sits in the panel's handoff order. */
  order: number
  /** Whose proposals it was handed before it started. Collaborative only. */
  handoffFrom: string[]
  handoffSha256: string | null
}

export interface PanelContextManifest {
  contextSha256?: string
  commonContextBytes?: number
  commonContextPath?: string
  brief?: { sha256: string; bytes: number }
  repositories?: { path: string; head: string | null }[]
  inputFiles?: {
    attachmentId: string
    originalName: string
    mediaType: string
    bytes: number
    sha256: string
    passthrough: string
    truncated?: boolean
  }[]
  productMd?: { path: string; sha256: string; included: boolean; reason?: string } | null
  designMd?: { path: string; sha256: string; included: boolean; reason?: string } | null
  designReferences?: {
    referenceId: string
    role: string
    name: string
    commit: string
    license: string
    sha256: string
    truncated: boolean
  }[]
  guidancePacks?: {
    packId: string
    commit: string
    license: string
    stability: string
    options: Record<string, number>
    documents: { document: string; path: string; includedBytes: number; totalBytes: number; truncated: boolean }[]
  }[]
}

export interface DesignPanel {
  schemaVersion: number
  runId: string
  panelId: string
  projectId: string | null
  state: string
  mode: string
  outputTarget: string
  createdAt: string | null
  updatedAt: string | null
  brief: string
  rolesConfirmed: boolean
  pendingRoles: string[]
  designerRole: string[]
  runState: string | null
  conceptStageReady: boolean
  reconcileStageReady: boolean
  barrierOpenedAt: string | null
  degradedApprovedAt: string | null
  packConflictAcknowledged: boolean
  packs: Record<string, Record<string, number>>
  references: string[]
  context: { contextSha256?: string; manifestSha256?: string; commonContextBytes?: number; manifestPath?: string }
  contextManifest: PanelContextManifest | null
  handoffOrder: string[]
  mediaFiles: {
    runPath: string | null
    sha256: string | null
    originalName: string | null
    mediaType: string | null
    bytes: number | null
  }[]
  participants: PanelParticipant[]
  succeededCount: number
  reconciliation: { state?: string; agentId?: string; error?: string | null; degraded?: boolean }
  artifacts: { path: string; present: boolean }[]
  comparisonDimensions: string[]
  nextAction: string | null
}

export interface DesignPanelResponse {
  schemaVersion: number
  designPanel: DesignPanel
}

export interface DesignReferenceEntry {
  id: string
  name: string | null
  description: string | null
  sourceUrl: string | null
  sha256: string | null
}

export interface DesignReferenceCatalog {
  schemaVersion: number
  available: boolean
  source: string | null
  commit: string | null
  license: string | null
  warning: string | null
  entries: DesignReferenceEntry[]
}

export interface GuidancePackDial {
  id: string
  label: string
  min: number
  max: number
  default: number
  help: string | null
}

export interface GuidancePack {
  packId: string
  label: string
  license: string | null
  commit: string | null
  sourceUrl: string | null
  stability: string | null
  stabilityNote: string | null
  changes: string[]
  conflictsWith: string[]
  dials: GuidancePackDial[]
  detector: {
    enabled?: boolean
    enabledByDefault?: boolean
    engineVersion?: string
    requires?: string
    networkBehaviour?: string
    hooks?: string
  } | null
}

export interface GuidancePackList {
  schemaVersion: number
  packs: GuidancePack[]
}

export interface DesignLens {
  id: string
  label: string
  text: string
}

export interface DesignLensList {
  schemaVersion: number
  lenses: DesignLens[]
}

// ------------------------------------------------------------- AI accounts --

/**
 * One provider the console can register an account for, as the controller
 * describes it. Nothing here is decided in the browser: which providers exist,
 * how each signs in, what fields it needs and whether its CLI is installed all
 * come from the controller's provider templates.
 */
export interface ProviderTemplate {
  provider: string
  label: string
  kind: string
  summary?: string | null
  loginMode: 'terminal' | 'secret' | 'none'
  loginInstruction?: string | null
  credentialEnv?: string | null
  credentialDirTemplate?: string | null
  cliRequired?: string | null
  cliInstalled?: boolean | null
  fields: ProviderField[]
  secret?: { label: string; minLength?: number; instruction?: string } | null
  capabilities: string[]
  /** Null where the provider accepts as many accounts as you like. */
  maxAccounts?: number | null
  maxAccountsReason?: string | null
  /** True where the credential cannot be split per account (an OS keyring). */
  sharedCredential: boolean
  multipleAccounts: boolean
  note?: string | null
  surface?: string | null
}

export interface ProviderField {
  name: string
  label: string
  required: boolean
  default?: string | null
  pattern?: string | null
}

/**
 * One registered account. `loggedIn` is the controller's answer, not a guess:
 * it asked the filesystem or the provider's own status command. No field here
 * ever carries a credential — `credentialDir` is a path, not its contents.
 */
export interface ProviderAccount {
  id: string
  label: string
  provider: string
  providerLabel: string
  kind: string | null
  account: string
  loginMode: 'terminal' | 'secret' | 'none'
  credentialDir: string
  loggedIn: boolean
  credentialSource: 'file' | 'keychain' | 'environment' | 'provider' | 'unconfirmed' | 'none'
  loginDetail: string
  available: boolean
  availability: string
  capabilities: string[]
  declared: boolean
  isolated: boolean
  fields: Record<string, string>
  note?: string | null
  surface?: string | null
  forbidden: string[]
  writeRequiresApproval: boolean
  confirmed?: boolean
  check?: {
    mode: 'probe' | 'argv'
    ran: boolean
    ok: boolean | null
    detail: string
    exitCode?: number
  }
  provisioning?: {
    ran: boolean
    reason?: string
    exitCode?: number
    detail?: string | null
  }
  nextAction?: string
}

export interface ProviderListResponse {
  schemaVersion: number
  providers: ProviderTemplate[]
}

export interface AccountListResponse {
  schemaVersion: number
  accounts: ProviderAccount[]
}

export interface AccountDetailResponse {
  schemaVersion: number
  account: ProviderAccount
}

export interface AccountRemovedResponse {
  schemaVersion: number
  removed: ProviderAccount
  credentials: { requested: boolean; removed: boolean; path: string; reason?: string }
  stillInUse: { runId: string; role: string; state?: string | null }[]
}

// ------------------------------------------------------- service connections --
export interface ConnectionProvider {
  provider: 'atlassian' | 'atlassian-rovo' | 'github' | 'bitbucket' | 'figma' | 'custom-mcp'
  label: string
  secretLabel: string | null
  docsUrl: string
  fields: {
    name: string; label: string; required: boolean; placeholder?: string
    type?: 'text' | 'url' | 'select'; defaultValue?: string
    options?: { value: string; label: string }[]
    showWhen?: { field: string; equals: string }
  }[]
  note: string
  oauth?: boolean
}

export interface ServiceConnection {
  id: string
  name: string
  provider: ConnectionProvider['provider']
  providerLabel: string
  fields: Record<string, string>
  configured: boolean
  status: string
  verifiedIdentity?: string | null
  verifiedAt?: string | null
  detail?: string | null
  oauth: boolean
  authMethod?: string
  /**
   * What the last verification learned about this connection's MCP tools.
   *
   * `readOnly === null` means "never asked", which is not the same as "safe":
   * the console must offer such a connection nowhere that claims read-only,
   * because nothing would be enforcing it.
   */
  verifiedTools?: number | null
  readOnly?: boolean | null
}

export interface ConnectionProviderListResponse {
  schemaVersion: 1
  providers: ConnectionProvider[]
}

export interface ConnectionListResponse {
  schemaVersion: 1
  connections: ServiceConnection[]
}

export interface ConnectionDetailResponse {
  schemaVersion: 1
  connection: ServiceConnection
}
