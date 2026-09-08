import { z } from 'zod'

/**
 * The controller's account contracts, pinned.
 *
 * `schemaVersion` is a literal, not a number: an answer written by a controller
 * that means something different by these fields is refused here rather than
 * rendered as if it agreed with us. The console reads accounts; it never writes
 * `agents.json`, so every shape below is something the controller produced.
 *
 * No field in any of these schemas carries a credential. The controller reports
 * whether a login exists and where its directory is — never a token, a secret
 * or the contents of a credential file — and this boundary is where that would
 * be caught if it ever changed.
 */
export const ACCOUNTS_SCHEMA_VERSION = 1

const version = z.literal(ACCOUNTS_SCHEMA_VERSION)

export const LOGIN_MODES = ['terminal', 'secret', 'none'] as const
export type LoginMode = (typeof LOGIN_MODES)[number]

/** A provider id is a template key: lowercase, hyphenated, bounded. */
export const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,39}$/

/** An identity id as the controller mints them. */
export const ACCOUNT_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/

export const providerFieldSchema = z.object({
  name: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  required: z.boolean(),
  default: z.string().max(200).nullable().optional(),
  pattern: z.string().max(400).nullable().optional(),
})

export const providerSchema = z.object({
  provider: z.string().regex(PROVIDER_PATTERN),
  label: z.string().min(1).max(120),
  kind: z.string().min(1).max(64),
  summary: z.string().max(600).nullable().optional(),
  loginMode: z.enum(LOGIN_MODES),
  loginInstruction: z.string().max(600).nullable().optional(),
  credentialEnv: z.string().max(120).nullable().optional(),
  credentialDirTemplate: z.string().max(400).nullable().optional(),
  cliRequired: z.string().max(120).nullable().optional(),
  cliInstalled: z.boolean().nullable().optional(),
  fields: z.array(providerFieldSchema).max(12),
  secret: z
    .object({
      label: z.string().min(1).max(120),
      minLength: z.number().int().min(1).max(4096).optional(),
      instruction: z.string().max(600).optional(),
    })
    .nullable()
    .optional(),
  capabilities: z.array(z.string().max(64)).max(64),
  /**
   * How many accounts this provider will accept, when it caps them, and why.
   * A provider whose credential lives in the OS keyring cannot keep two
   * accounts apart, so it reports one — and the reason, in the controller's own
   * words, so the panel states the limit rather than inventing an explanation.
   */
  maxAccounts: z.number().int().min(1).max(64).nullable().optional(),
  maxAccountsReason: z.string().max(600).nullable().optional(),
  sharedCredential: z.boolean(),
  multipleAccounts: z.boolean(),
  note: z.string().max(600).nullable().optional(),
  surface: z.string().max(600).nullable().optional(),
})

export const providerListSchema = z.object({
  schemaVersion: version,
  providers: z.array(providerSchema).max(64),
})

export const accountSchema = z.object({
  id: z.string().regex(ACCOUNT_KEY_PATTERN),
  label: z.string().min(1).max(200),
  provider: z.string().regex(PROVIDER_PATTERN),
  providerLabel: z.string().min(1).max(120),
  kind: z.string().max(64).nullable(),
  account: z.string().max(64),
  loginMode: z.enum(LOGIN_MODES),
  credentialDir: z.string().max(4096),
  loggedIn: z.boolean(),
  credentialSource: z.enum(['file', 'keychain', 'environment', 'provider', 'unconfirmed', 'none']),
  loginDetail: z.string().max(600),
  available: z.boolean(),
  availability: z.string().max(600),
  capabilities: z.array(z.string().max(64)).max(64),
  declared: z.boolean(),
  isolated: z.boolean(),
  fields: z.record(z.string(), z.string().max(400)),
  note: z.string().max(600).nullable().optional(),
  surface: z.string().max(600).nullable().optional(),
  forbidden: z.array(z.string().max(64)).max(32),
  writeRequiresApproval: z.boolean(),
  // Present only on verify: whether the check could actually be run. A missing
  // status command answers neither way, and saying so is not the same as
  // reporting a signed-out account.
  confirmed: z.boolean().optional(),
  check: z
    .object({
      mode: z.enum(['probe', 'argv']),
      ran: z.boolean(),
      ok: z.boolean().nullable(),
      detail: z.string().max(600),
      exitCode: z.number().int().optional(),
    })
    .optional(),
  provisioning: z
    .object({
      ran: z.boolean(),
      reason: z.string().max(400).optional(),
      exitCode: z.number().int().optional(),
      detail: z.string().max(600).nullable().optional(),
    })
    .optional(),
  nextAction: z.string().max(200).optional(),
})

export const accountListSchema = z.object({
  schemaVersion: version,
  accounts: z.array(accountSchema).max(128),
})

export const accountDetailSchema = z.object({
  schemaVersion: version,
  account: accountSchema,
})

export const accountRemovedSchema = z.object({
  schemaVersion: version,
  removed: accountSchema,
  credentials: z.object({
    requested: z.boolean(),
    removed: z.boolean(),
    path: z.string().max(4096),
    reason: z.string().max(400).optional(),
  }),
  stillInUse: z
    .array(
      z.object({
        runId: z.string().max(200),
        role: z.string().max(64),
        state: z.string().max(64).nullable().optional(),
      }),
    )
    .max(200),
})

/**
 * The login plan. `argv` and `env` come back so the console can start exactly
 * the process the controller described — as an argument array, never a command
 * string, so nothing in an account name can become a flag.
 */
export const accountLoginSchema = z.object({
  schemaVersion: version,
  login: z.object({
    accountId: z.string().regex(ACCOUNT_KEY_PATTERN),
    provider: z.string().regex(PROVIDER_PATTERN),
    argv: z.array(z.string().min(1).max(400)).min(1).max(24),
    env: z.record(z.string(), z.string().max(4096)),
    cwd: z.string().max(4096),
    instruction: z.string().max(600).nullable().optional(),
    interactiveUi: z.boolean(),
    verifyCommand: z.array(z.string().max(200)).max(12),
  }),
})

export type ProviderTemplate = z.infer<typeof providerSchema>
export type ProviderAccount = z.infer<typeof accountSchema>
