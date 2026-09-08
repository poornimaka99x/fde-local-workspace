import { z } from 'zod'

export const connectionProviderSchema = z.object({
  provider: z.enum(['atlassian', 'github', 'bitbucket', 'figma']),
  label: z.string(),
  secretLabel: z.string().nullable(),
  docsUrl: z.string().url(),
  fields: z.array(z.object({
    name: z.string(), label: z.string(), required: z.boolean(), placeholder: z.string().optional(),
  })),
  note: z.string(),
  oauth: z.boolean().optional(),
})

export const connectionSchema = z.object({
  id: z.string(), name: z.string(),
  provider: z.enum(['atlassian', 'github', 'bitbucket', 'figma']),
  providerLabel: z.string(), fields: z.record(z.string()),
  configured: z.boolean(), status: z.string(),
  verifiedIdentity: z.string().nullable().optional(),
  verifiedAt: z.string().nullable().optional(),
  detail: z.string().nullable().optional(), oauth: z.boolean(),
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

