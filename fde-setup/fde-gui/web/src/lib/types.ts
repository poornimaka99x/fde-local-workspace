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
  warnings: string[]
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
  provider: 'anthropic' | 'bedrock' | 'codex'
  profilePresent: boolean
  authState: 'authenticated' | 'login_required' | 'external' | 'unavailable'
  authMethod: string | null
  models: ClaudeModelOption[]
  capabilities: string[]
  designPanelEligible: boolean
}

export interface ClaudeAccountsResponse {
  accounts: ClaudeAccount[]
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
  provider: 'anthropic' | 'bedrock' | 'codex'
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
