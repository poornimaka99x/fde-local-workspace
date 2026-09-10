/**
 * The MCP catalogue as the console sees it.
 *
 * Kept beside the view rather than in the shared types module because these
 * shapes mirror the controller's status record one-for-one, and the controller
 * is the only thing allowed to decide them. Nothing here can hold a credential:
 * `credentialsPresent` says whether one exists, never what it is.
 */
export type McpLifecycle =
  | 'unavailable' | 'not_configured' | 'authentication_required'
  | 'ready' | 'active' | 'unhealthy' | 'blocked'

export interface McpField {
  name: string
  label: string
  required: boolean
  secret: boolean
  type: string
  options: { value: string, label: string }[]
  placeholder?: string | null
  help?: string | null
  warning?: string | null
  showWhen?: { field: string, equals: string } | null
}

export interface McpServer {
  name: string
  state: McpLifecycle
  reason: string
  enabled: boolean
  transport: string
  auth: string
  classification: string
  mutation: 'read-only' | 'mutation-capable'
  readOnlyPolicy: string
  targets: string[]
  stages: string[]
  profiles: string[]
  package: string | null
  missingDependencies: string[]
  missingConfiguration: string[]
  requiredFields: McpField[]
  credentialsPresent: Record<string, boolean>
  /** null: nothing to filter. []: nothing could be proved safe — hence blocked. */
  enforceableTools: string[] | null
  /** The server reaches a session with its write tools intact. Say so loudly. */
  unscopedWrites: boolean
  verification: {
    at?: string | null
    initialize?: number | null
    toolCount?: number | null
    outcome?: string | null
    detail?: string | null
  }
  gateway: Record<string, string>
  useWhen: string
  preferOver: string[]
  doNotUseWhen: string
  setup?: string | null
  docsUrl?: string | null
  note: string
  values: Record<string, string>
}

export interface McpProfile {
  name: string
  label: string
  description: string
  servers: string[]
  docker?: string | null
}

export interface McpListResponse {
  schemaVersion: number
  catalogue: {
    path: string
    valid: boolean
    problems: string[]
    schemaVersionOnDisk: number
  }
  profiles: McpProfile[]
  servers: McpServer[]
}

export interface McpDetailResponse { schemaVersion: number, server: McpServer }

export interface McpGatewayResponse {
  schemaVersion: number
  available: boolean
  detail: string
  profile?: string | null
  routedThroughGateway: Record<string, string>
  runDirectly: string[]
  dockerProfiles: string[]
  note: string
}

export interface McpEffectiveResponse {
  schemaVersion: number
  runId?: string | null
  profile?: string | null
  roles: string[]
  stages: string[]
  active: {
    name: string
    mutation: 'read-only' | 'mutation-capable'
    classification: string
    allowedTools: string[] | null
    identities: string[]
  }[]
  refused: { name: string, state: McpLifecycle, reason: string }[]
}

/** What each lifecycle state means, in the operator's words rather than ours. */
export const MCP_STATE_LABEL: Record<McpLifecycle, string> = {
  unavailable: 'unavailable',
  not_configured: 'not configured',
  authentication_required: 'sign-in needed',
  ready: 'ready',
  active: 'active',
  unhealthy: 'unhealthy',
  blocked: 'blocked',
}

export function mcpStateClass(state: McpLifecycle): string {
  if (state === 'ready' || state === 'active') return 'ok'
  if (state === 'unhealthy' || state === 'blocked') return 'danger'
  return 'warn'
}

/**
 * The one sentence that matters on a card: what this server can do to the world
 * once it is active, and whether FDE can prove the limit.
 */
export function mcpScopeSummary(server: McpServer): string {
  if (server.mutation === 'read-only') return 'Read-only'
  if (server.unscopedWrites) return 'Unscoped — write tools reach the session'
  if (server.enforceableTools === null) return 'Read-only while its own read-only mode is set'
  if (server.enforceableTools.length === 0) return 'Mutation tools cannot be governed yet'
  return `Read-only — ${server.enforceableTools.length} verified tool(s) allowed`
}
