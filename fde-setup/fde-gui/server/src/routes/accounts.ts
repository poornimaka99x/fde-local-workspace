import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type WebSocket from 'ws'
import { z } from 'zod'
import type { GuiConfig } from '../config'
import { problem } from '../problem'
import { describeZod, line } from '../schemas/input'
import {
  ACCOUNT_KEY_PATTERN,
  PROVIDER_PATTERN,
  accountDetailSchema,
  accountListSchema,
  accountLoginSchema,
  accountRemovedSchema,
  providerListSchema,
} from '../schemas/accounts'
import {
  ControllerError,
  runControllerJson,
  runControllerWithStdin,
} from '../services/controller'
import { NoSuchSession, SessionExists } from '../services/sessions'
import type { Services } from '../services/types'
import { attachTerminal, loginKeysFor, runningLogin } from './terminal'

/**
 * The AI-accounts API.
 *
 * The same three rules the routing API holds itself to apply here, for the same
 * reason:
 *
 * 1. **The controller decides.** Every endpoint is a controller JSON command.
 *    This server does not write `agents.json`, does not invent an account id,
 *    does not decide which directory isolates which provider, and does not
 *    judge whether an account is signed in. It cannot: it never opens those
 *    files.
 * 2. **A secret is never argv and never a response.** A pasted secret goes to
 *    the controller's stdin, so it does not appear in this machine's process
 *    list. Nothing this file returns has ever held a credential — the
 *    controller reports the existence of one, not its value.
 * 3. **A login is the operator's, interactively.** Sign-in runs as a terminal
 *    the operator watches and types into, started from the exact argv and
 *    environment the controller described. This server composes no login
 *    command of its own.
 */

const accountParams = z.object({ accountId: z.string().regex(ACCOUNT_KEY_PATTERN) })

/**
 * A field value for a provider template field.
 *
 * The controller validates each against its own declared pattern and refuses
 * what does not match; this bound is only about what may reach argv at all.
 */
const FIELD_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:@=+/-]{0,199}$/
const FIELD_NAME_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/

const createAccountBody = z.object({
  provider: z.string().regex(PROVIDER_PATTERN, 'not a known provider'),
  name: line(49)
    .transform((value) => value.trim())
    .pipe(z.string().min(1, 'an account needs a name')),
  fields: z
    .record(z.string().regex(FIELD_NAME_PATTERN), z.string().regex(FIELD_VALUE_PATTERN))
    .default({}),
})

const updateAccountBody = z.object({
  fields: z
    .record(z.string().regex(FIELD_NAME_PATTERN), z.string().regex(FIELD_VALUE_PATTERN))
    .refine((value) => Object.keys(value).length > 0, 'at least one setting is required'),
})

/**
 * A destructive option is opt-in by its exact word, never by coercion.
 *
 * `z.coerce.boolean()` is `Boolean(value)`, so the string "false" is true — and
 * the console always sends the parameter explicitly. That turned an unticked
 * "delete the credential folder" box into a deletion, and would have let any
 * client send `force=false` and walk past the in-use guard.
 */
const optionalFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true')

const removeQuery = z.object({
  purgeCredentials: optionalFlag,
  force: optionalFlag,
})

/**
 * A pasted secret, bounded but otherwise untouched.
 *
 * It is not pattern-matched here: a Direct Line secret is opaque vendor text
 * and a console that guessed at its alphabet would reject valid ones. The
 * controller enforces the provider's own minimum and refuses a multi-line
 * paste. This never becomes argv, so there is nothing to escape.
 */
const secretBody = z.object({
  secret: z.string().min(1, 'a secret is required').max(8192),
})

const stopBody = z.object({ force: z.boolean().default(false) }).default({ force: false })

/**
 * The controller's typed account refusal, surfaced as itself.
 *
 * In JSON mode a refusal is `{"error":{code,message,hint}}` on stdout with a
 * documented exit code, which arrives here as the ControllerError's detail.
 * Parsing it back means the browser sees `duplicate_account` rather than a
 * generic "the controller refused this request".
 */
export function accountProblem(reply: FastifyReply, error: ControllerError): unknown {
  if (typeof error.detail === 'string') {
    try {
      const parsed = JSON.parse(error.detail) as {
        error?: { code?: unknown; message?: unknown; hint?: unknown }
      }
      const code = parsed.error?.code
      const message = parsed.error?.message
      if (typeof code === 'string' && typeof message === 'string') {
        return problem(
          reply,
          error.status,
          code.replace(/_/g, '-'),
          message,
          typeof parsed.error?.hint === 'string' ? parsed.error.hint : undefined,
        )
      }
    } catch {
      /* Not an account envelope. The generic mapping is the right answer. */
    }
  }
  return problem(reply, error.status, error.code, error.message, error.detail)
}

/**
 * A controller call whose outcome the caller can still branch on.
 *
 * `problem()` writes the reply, so a helper that returns its value gives the
 * caller no way to tell an answer from a refusal — and a caller that then set
 * a 201 status, or touched the change watcher, would be doing it to a reply
 * that had already been sent. The tag makes that impossible to get wrong.
 */
type ControllerOutcome<T> = { ok: true; value: T } | { ok: false; sent: unknown }

async function callController<T>(
  config: GuiConfig,
  reply: FastifyReply,
  args: readonly string[],
  parse: (raw: unknown) => T,
): Promise<ControllerOutcome<T>> {
  try {
    return { ok: true, value: parse(await runControllerJson(config, args)) }
  } catch (error) {
    if (error instanceof ControllerError) return { ok: false, sent: accountProblem(reply, error) }
    throw error
  }
}

async function controllerJson<T>(
  config: GuiConfig,
  reply: FastifyReply,
  args: readonly string[],
  parse: (raw: unknown) => T,
): Promise<T | unknown> {
  const outcome = await callController(config, reply, args, parse)
  return outcome.ok ? outcome.value : outcome.sent
}

/** The terminal key for one account's sign-in. One at a time, per account. */
function loginKey(accountId: string): string {
  return `account-login:${accountId}`
}

export function registerAccountRoutes(
  app: FastifyInstance,
  config: GuiConfig,
  services: Services,
): void {
  app.get('/api/accounts/providers', async (_request, reply) =>
    await controllerJson(config, reply, ['accounts', 'providers', '--json'], (raw) =>
      providerListSchema.parse(raw)),
  )

  app.get('/api/accounts', async (request, reply) => {
    const query = request.query as { loggedIn?: string; provider?: string }
    const args = ['accounts', 'list', '--json']
    if (query.loggedIn === 'true') args.push('--logged-in')
    if (typeof query.provider === 'string') {
      if (!PROVIDER_PATTERN.test(query.provider)) {
        return problem(reply, 400, 'invalid-provider', 'That is not a provider id.')
      }
      args.push('--provider', query.provider)
    }
    return await controllerJson(config, reply, args, (raw) => accountListSchema.parse(raw))
  })

  app.post('/api/accounts', async (request, reply) => {
    const parsed = createAccountBody.safeParse(request.body)
    if (!parsed.success) {
      return problem(reply, 400, 'invalid-body', 'That account cannot be created as described.',
        describeZod(parsed.error))
    }
    const { provider, name, fields } = parsed.data
    // One writer at a time: two consoles adding an account in the same instant
    // would each read the registry and the second write would drop the first.
    // The controller also locks; this keeps the console's own answer coherent.
    const release = services.locks.tryAcquire('accounts')
    if (release === null) return problem(reply, 409, 'busy', 'Accounts are being changed right now.')
    try {
      const args = ['accounts', 'add', '--provider', provider, '--name', name, '--json']
      for (const [key, value] of Object.entries(fields)) {
        args.push(`--${key.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`)}`, value)
      }
      const outcome = await callController(config, reply, args, (raw) =>
        accountDetailSchema.parse(raw))
      if (!outcome.ok) return outcome.sent
      services.watcher.touch()
      return await reply.status(201).send(outcome.value)
    } finally {
      release()
    }
  })

  app.patch<{ Params: { accountId: string } }>('/api/accounts/:accountId', async (request, reply) => {
    const params = accountParams.safeParse(request.params)
    if (!params.success) return problem(reply, 400, 'invalid-account', 'That account id is not valid.')
    const parsed = updateAccountBody.safeParse(request.body)
    if (!parsed.success) {
      return problem(reply, 400, 'invalid-body', 'Those account settings cannot be saved.',
        describeZod(parsed.error))
    }
    const release = services.locks.tryAcquire('accounts')
    if (release === null) return problem(reply, 409, 'busy', 'Accounts are being changed right now.')
    try {
      const args = ['accounts', 'update', params.data.accountId, '--json']
      for (const [key, value] of Object.entries(parsed.data.fields)) {
        args.push(`--${key.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`)}`, value)
      }
      const outcome = await callController(config, reply, args, (raw) =>
        accountDetailSchema.parse(raw))
      if (!outcome.ok) return outcome.sent
      services.watcher.touch()
      return outcome.value
    } finally {
      release()
    }
  })

  app.delete<{ Params: { accountId: string } }>('/api/accounts/:accountId', async (request, reply) => {
    const params = accountParams.safeParse(request.params)
    if (!params.success) return problem(reply, 400, 'invalid-account', 'That account id is not valid.')
    const query = removeQuery.safeParse(request.query ?? {})
    if (!query.success) return problem(reply, 400, 'invalid-query', 'Unusable removal options.')
    const release = services.locks.tryAcquire('accounts')
    if (release === null) return problem(reply, 409, 'busy', 'Accounts are being changed right now.')
    try {
      const args = ['accounts', 'remove', params.data.accountId, '--json']
      if (query.data.purgeCredentials) args.push('--purge-credentials')
      if (query.data.force) args.push('--force')
      const outcome = await callController(config, reply, args, (raw) =>
        accountRemovedSchema.parse(raw))
      if (!outcome.ok) return outcome.sent
      services.watcher.touch()
      return outcome.value
    } finally {
      release()
    }
  })

  app.post<{ Params: { accountId: string } }>('/api/accounts/:accountId/verify', async (request, reply) => {
    const params = accountParams.safeParse(request.params)
    if (!params.success) return problem(reply, 400, 'invalid-account', 'That account id is not valid.')
    // "Not signed in" is a correct answer, and the controller says it with exit
    // 4 — which the generic mapping would turn into a 404, as though the
    // account did not exist. The record is on stdout either way, so a refusal
    // whose detail parses as an account record is returned as the answer it is.
    try {
      return accountDetailSchema.parse(
        await runControllerJson(config, ['accounts', 'verify', params.data.accountId, '--json']),
      )
    } catch (error) {
      if (error instanceof ControllerError) {
        if (typeof error.detail === 'string') {
          try {
            return accountDetailSchema.parse(JSON.parse(error.detail))
          } catch {
            /* Not an account record — the refusal stands. */
          }
        }
        return accountProblem(reply, error)
      }
      throw error
    }
  })

  app.post<{ Params: { accountId: string } }>('/api/accounts/:accountId/secret', async (request, reply) => {
    const params = accountParams.safeParse(request.params)
    if (!params.success) return problem(reply, 400, 'invalid-account', 'That account id is not valid.')
    const body = secretBody.safeParse(request.body)
    if (!body.success) {
      return problem(reply, 400, 'invalid-body', 'A secret is required.', describeZod(body.error))
    }
    const release = services.locks.tryAcquire('accounts')
    if (release === null) return problem(reply, 409, 'busy', 'Accounts are being changed right now.')
    try {
      // stdin, never argv: the value must not appear in this machine's process
      // list, and nothing between here and the controller writes it anywhere.
      const raw = await runControllerWithStdin(
        config,
        ['accounts', 'set-secret', params.data.accountId, '--json'],
        Readable.from([Buffer.from(body.data.secret, 'utf8')]),
        8192,
      )
      services.watcher.touch()
      return accountDetailSchema.parse(raw)
    } catch (error) {
      if (error instanceof ControllerError) return accountProblem(reply, error)
      throw error
    } finally {
      release()
    }
  })

  app.get<{ Params: { accountId: string } }>('/api/accounts/:accountId/login', async (request, reply) => {
    const params = accountParams.safeParse(request.params)
    if (!params.success) return problem(reply, 400, 'invalid-account', 'That account id is not valid.')
    return await controllerJson(
      config, reply,
      ['accounts', 'login', params.data.accountId, '--json'],
      (raw) => accountLoginSchema.parse(raw),
    )
  })

  app.post<{ Params: { accountId: string } }>('/api/accounts/:accountId/login', async (request, reply) => {
    const params = accountParams.safeParse(request.params)
    if (!params.success) return problem(reply, 400, 'invalid-account', 'That account id is not valid.')
    const accountId = params.data.accountId
    if (!services.sessions.available) {
      return problem(reply, 503, 'terminal-unavailable', 'Interactive sign-in needs the terminal backend.')
    }
    const key = loginKey(accountId)
    if (services.sessions.isRunning(key)) {
      return {
        status: 'existing',
        session: services.sessions.get(key),
        ticket: services.sessions.issueTicket(key),
      }
    }
    let plan: z.infer<typeof accountLoginSchema>['login']
    try {
      plan = accountLoginSchema.parse(
        await runControllerJson(config, ['accounts', 'login', accountId, '--json']),
      ).login
    } catch (error) {
      if (error instanceof ControllerError) return accountProblem(reply, error)
      throw error
    }
    // The chat-accounts screen signs in by Claude profile, this one by registry
    // identity. Both write the same credential directory, so a sign-in already
    // running there is this account's sign-in — surfaced as the one that
    // exists rather than started a second time on top of it.
    const configDir = plan.env.CLAUDE_CONFIG_DIR
    const profile = typeof configDir === 'string' && configDir !== ''
      ? configDir.split('/').filter((part) => part !== '').pop() ?? null
      : null
    const elsewhere = runningLogin(services.sessions, loginKeysFor(profile, accountId))
    if (elsewhere !== null) {
      return {
        status: 'existing',
        session: services.sessions.get(elsewhere),
        ticket: services.sessions.issueTicket(elsewhere),
        instruction: plan.instruction ?? null,
      }
    }
    const [file, ...args] = plan.argv
    if (file === undefined) {
      return problem(reply, 502, 'controller-unreadable', 'The controller described no sign-in command.')
    }
    try {
      // The controller's environment is applied on top of the console's own
      // session environment, so the credential variable it named is the one
      // this process sees — and no variable the console holds can override it.
      const session = services.sessions.startCommand({
        sessionId: key,
        file,
        args,
        cwd: plan.cwd,
        env: { ...services.accounts.loginEnv(), ...plan.env },
      })
      return await reply.status(201).send({
        status: 'started',
        session,
        ticket: services.sessions.issueTicket(key),
        instruction: plan.instruction ?? null,
      })
    } catch (error) {
      if (error instanceof SessionExists) {
        return {
          status: 'existing',
          session: services.sessions.get(key),
          ticket: services.sessions.issueTicket(key),
        }
      }
      throw error
    }
  })

  app.post<{ Params: { accountId: string } }>('/api/accounts/:accountId/login/stop', async (request, reply) => {
    const params = accountParams.safeParse(request.params)
    if (!params.success) return problem(reply, 400, 'invalid-account', 'That account id is not valid.')
    const body = stopBody.safeParse(request.body ?? {})
    if (!body.success) return problem(reply, 400, 'invalid-body', 'Unusable stop request.')
    try {
      return services.sessions.stop(loginKey(params.data.accountId), body.data)
    } catch (error) {
      if (error instanceof NoSuchSession) {
        return problem(reply, 404, 'no-session', 'This account has no sign-in session.')
      }
      throw error
    }
  })

  app.get<{ Params: { accountId: string }; Querystring: { ticket?: string } }>(
    '/api/accounts/:accountId/login/terminal',
    { websocket: true },
    (socket: WebSocket, request) => {
      const params = accountParams.safeParse(request.params)
      const key = params.success ? loginKey(params.data.accountId) : ''
      const ticket = typeof request.query.ticket === 'string' ? request.query.ticket : ''
      if (key === '' || ticket === '' || !services.sessions.redeemTicket(ticket, key)) {
        socket.close(4401, 'unauthenticated')
        return
      }
      attachTerminal(socket, services.sessions, key)
    },
  )
}
