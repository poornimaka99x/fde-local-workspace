import { z } from 'zod'

/**
 * The governed MCP catalogue, as the controller reports it.
 *
 * Four words mean four different things here and the console must never blur
 * them: a server is in the *catalogue* (FDE knows how to run it), *configured*
 * (the operator supplied what it needs), *ready* (available, configured and
 * verified) or *active* (part of a specific run or chat's effective set).
 * Nothing in this file ever carries a credential value — only whether one is
 * present.
 */
export const mcpLifecycleSchema = z.enum([
  'unavailable', 'not_configured', 'authentication_required',
  'ready', 'active', 'unhealthy', 'blocked',
])

export const mcpFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  required: z.boolean(),
  secret: z.boolean(),
  type: z.string(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).default([]),
  placeholder: z.string().nullable().optional(),
  help: z.string().nullable().optional(),
  warning: z.string().nullable().optional(),
  showWhen: z.object({ field: z.string(), equals: z.string() }).nullable().optional(),
})

export const mcpVerificationSchema = z.object({
  at: z.string().nullable().optional(),
  initialize: z.number().nullable().optional(),
  toolCount: z.number().nullable().optional(),
  outcome: z.string().nullable().optional(),
  detail: z.string().nullable().optional(),
})

export const mcpServerSchema = z.object({
  name: z.string(),
  state: mcpLifecycleSchema,
  reason: z.string(),
  enabled: z.boolean(),
  transport: z.string(),
  auth: z.string(),
  classification: z.string(),
  mutation: z.enum(['read-only', 'mutation-capable']),
  readOnlyPolicy: z.string(),
  targets: z.array(z.string()),
  stages: z.array(z.string()),
  profiles: z.array(z.string()),
  package: z.string().nullable(),
  missingDependencies: z.array(z.string()),
  missingConfiguration: z.array(z.string()),
  requiredFields: z.array(mcpFieldSchema),
  credentialsPresent: z.record(z.boolean()),
  /** null means "nothing to filter"; [] means "nothing could be proved safe". */
  enforceableTools: z.array(z.string()).nullable(),
  /** True when the server reaches a session with its write tools intact. */
  unscopedWrites: z.boolean().default(false),
  verification: mcpVerificationSchema,
  gateway: z.record(z.string()).default({}),
  useWhen: z.string(),
  preferOver: z.array(z.string()),
  doNotUseWhen: z.string(),
  setup: z.string().nullable().optional(),
  docsUrl: z.string().nullable().optional(),
  note: z.string(),
  values: z.record(z.string()).default({}),
})

export const mcpProfileSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string(),
  servers: z.array(z.string()),
  docker: z.string().nullable().optional(),
})

export const mcpListResponseSchema = z.object({
  schemaVersion: z.number(),
  catalogue: z.object({
    path: z.string(),
    valid: z.boolean(),
    problems: z.array(z.string()).default([]),
    schemaVersionOnDisk: z.number(),
  }),
  profiles: z.array(mcpProfileSchema),
  servers: z.array(mcpServerSchema),
})

export const mcpDetailResponseSchema = z.object({
  schemaVersion: z.number(),
  server: mcpServerSchema,
})

export const mcpEffectiveResponseSchema = z.object({
  schemaVersion: z.number(),
  runId: z.string().nullable().optional(),
  profile: z.string().nullable().optional(),
  roles: z.array(z.string()).default([]),
  stages: z.array(z.string()).default([]),
  active: z.array(z.object({
    name: z.string(),
    mutation: z.enum(['read-only', 'mutation-capable']),
    classification: z.string(),
    allowedTools: z.array(z.string()).nullable(),
    identities: z.array(z.string()).default([]),
  })),
  refused: z.array(z.object({
    name: z.string(),
    state: mcpLifecycleSchema,
    reason: z.string(),
  })),
})

export const mcpGatewayResponseSchema = z.object({
  schemaVersion: z.number(),
  available: z.boolean(),
  detail: z.string(),
  profile: z.string().nullable().optional(),
  routedThroughGateway: z.record(z.string()),
  runDirectly: z.array(z.string()),
  dockerProfiles: z.array(z.string()),
  note: z.string(),
})

export const mcpServerIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
export const mcpFieldIdSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/)
