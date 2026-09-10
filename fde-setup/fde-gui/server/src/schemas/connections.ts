import { z } from 'zod'

export const connectionProviderIdSchema = z.enum(['atlassian', 'atlassian-rovo', 'github', 'bitbucket', 'figma', 'custom-mcp'])

export const connectionProviderSchema = z.object({
  provider: connectionProviderIdSchema,
  label: z.string(),
  secretLabel: z.string().nullable(),
  docsUrl: z.string().url(),
  fields: z.array(z.object({
    name: z.string(), label: z.string(), required: z.boolean(), placeholder: z.string().optional(),
    type: z.enum(['text', 'url', 'select']).optional(), defaultValue: z.string().optional(),
    options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    showWhen: z.object({ field: z.string(), equals: z.string() }).optional(),
  })),
  note: z.string(),
  oauth: z.boolean().optional(),
})

export const connectionSchema = z.object({
  id: z.string(), name: z.string(),
  provider: connectionProviderIdSchema,
  providerLabel: z.string(), fields: z.record(z.string()),
  configured: z.boolean(), status: z.string(),
  verifiedIdentity: z.string().nullable().optional(),
  verifiedAt: z.string().nullable().optional(),
  detail: z.string().nullable().optional(), oauth: z.boolean(), authMethod: z.string().optional(),
  // How many tools the last verification found, and whether all of them only
  // read. `null` means "not verified", which the console must not render as
  // read-only — that distinction is the whole point of these two fields.
  verifiedTools: z.number().nullable().optional(),
  readOnly: z.boolean().nullable().optional(),
})

export const connectionProvidersResponseSchema = z.object({
  schemaVersion: z.literal(1), providers: z.array(connectionProviderSchema),
})
export const connectionListResponseSchema = z.object({
  schemaVersion: z.literal(1), connections: z.array(connectionSchema),
})
export const connectionDetailResponseSchema = z.object({
  schemaVersion: z.literal(1), connection: connectionSchema,
})
export const connectionRemovedResponseSchema = z.object({
  schemaVersion: z.literal(1), removed: connectionSchema,
})
