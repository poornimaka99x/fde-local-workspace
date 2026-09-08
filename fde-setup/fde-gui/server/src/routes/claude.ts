import { existsSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { GuiConfig } from '../config'
import { problem } from '../problem'
import { projectDetailSchema } from '../schemas/controller'
import { connectionListResponseSchema } from '../schemas/connections'
import { block, describeZod, line } from '../schemas/input'
import { ACCOUNT_ID_PATTERN, EFFORTS, MODEL_PATTERN, ProfileDirectoryError, type Effort } from '../services/accounts'
import { ChatBusy, CHAT_ID_PATTERN, ChatNotFound, InvalidAttachment } from '../services/chats'
import { PROJECT_ID_PATTERN, runControllerJson } from '../services/controller'
import { NoSuchSession, SessionExists, sessionCwd } from '../services/sessions'
import type { Services } from '../services/types'
import { attachTerminal, runningLogin } from './terminal'

const accountParams = z.object({ accountId: z.string().regex(ACCOUNT_ID_PATTERN) })
const chatParams = z.object({ chatId: z.string().regex(CHAT_ID_PATTERN) })
const createChatBody = z.object({
  title: line(120).optional(),
  accountId: z.string().regex(ACCOUNT_ID_PATTERN),
  model: z.string().regex(MODEL_PATTERN).default('default'),
  effort: z.enum(EFFORTS).default('auto'),
  projectId: z.string().regex(PROJECT_ID_PATTERN).nullable().optional(),
  serviceConnectionIds: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,79}$/)).max(12).default([]),
})
const messageBody = z.object({ message: block(20_000).transform((value) => value.trim()).pipe(z.string().min(1)) })
const titleBody = z.object({ title: line(120).transform((value) => value.trim()).pipe(z.string().min(1)) })
const serviceAccessBody = z.object({
  serviceConnectionIds: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,79}$/)).max(12),
})
const stopBody = z.object({ force: z.boolean().default(false) }).default({ force: false })
const attachmentBody = z.object({
  path: line(4096).transform((value) => value.trim()).pipe(z.string().min(1, 'a path is required')),
})
const attachmentParams = z.object({
  chatId: z.string().regex(CHAT_ID_PATTERN),
  attachmentId: z.string().regex(/^[0-9a-fA-F-]{1,64}$/),
})

async function serviceSelectionAvailable(config: GuiConfig, ids: string[]): Promise<boolean> {
  if (new Set(ids).size !== ids.length) return false
  if (ids.length === 0) return true
  const available = connectionListResponseSchema.parse(
    await runControllerJson(config, ['connections', 'list', '--json']),
  ).connections
  return ids.every((id) => available.some((item) => item.id === id && item.configured))
}

/** Account, login and general-chat surfaces. No endpoint accepts a command. */
export function registerClaudeRoutes(
  app: FastifyInstance,
  config: GuiConfig,
  services: Services,
): void {
  app.get('/api/claude/accounts', async (request) => {
    const query = request.query as { refresh?: string }
    return { accounts: await services.accounts.list(query.refresh === 'true') }
  })

  app.get<{ Params: { accountId: string } }>('/api/claude/accounts/:accountId/status', async (request, reply) => {
    const parsed = accountParams.safeParse(request.params)
    if (!parsed.success || services.accounts.getConfigured(parsed.data?.accountId ?? '') === null) {
      return problem(reply, 404, 'account-not-found', 'That chat account is not configured.')
    }
    return await services.accounts.status(parsed.data.accountId, true)
  })

  app.post<{ Params: { accountId: string } }>('/api/claude/accounts/:accountId/login', async (request, reply) => {
    const parsed = accountParams.safeParse(request.params)
    if (!parsed.success) return problem(reply, 400, 'invalid-account', 'That account id is not valid.')
    const account = services.accounts.getConfigured(parsed.data.accountId)
    if (account === null) return problem(reply, 404, 'account-not-found', 'That chat account is not configured.')
    if (account.provider === 'bedrock') {
      return problem(reply, 409, 'external-auth', 'Bedrock authentication is managed through AWS credentials.')
    }
    if (!services.accounts.binaryAvailable(account.provider)) {
      return problem(reply, 503, 'chat-provider-unavailable', 'The selected chat CLI is not available to this console.')
    }
    if (!services.sessions.available) {
      return problem(reply, 503, 'terminal-unavailable', 'Interactive login needs the terminal backend.')
    }
    // Both sign-in surfaces write the same credential directory, so a sign-in
    // running under the AI-accounts key is this account's sign-in too.
    const keys = [`login:${account.id}`]
    if (account.identityId !== null) keys.push(`account-login:${account.identityId}`)
    const running = runningLogin(services.sessions, keys)
    if (running !== null) {
      return {
        status: 'existing',
        session: services.sessions.get(running),
        ticket: services.sessions.issueTicket(running),
      }
    }
    const key = keys[0] as string
    let spec: ReturnType<typeof services.accounts.prepareLogin>
    try {
      spec = services.accounts.prepareLogin(account.id)
    } catch (error) {
      if (error instanceof ProfileDirectoryError) {
        process.stderr.write(`fde-gui: ${error.message}\n`)
        return problem(
          reply,
          500,
          'profile-directory-error',
          'Could not prepare the Claude profile folder for this account.',
          error.message,
        )
      }
      throw error
    }
    if (spec === null) return problem(reply, 409, 'login-unavailable', 'Login is not available for this account.')
    try {
      const session = services.sessions.startCommand({ sessionId: key, ...spec })
      return await reply.status(201).send({ status: 'started', session, ticket: services.sessions.issueTicket(key) })
    } catch (error) {
      if (error instanceof SessionExists) {
        return { status: 'existing', session: services.sessions.get(key), ticket: services.sessions.issueTicket(key) }
      }
      throw error
    }
  })

  app.post<{ Params: { accountId: string } }>('/api/claude/accounts/:accountId/login/stop', async (request, reply) => {
    const parsed = accountParams.safeParse(request.params)
    if (!parsed.success) return problem(reply, 400, 'invalid-account', 'That account id is not valid.')
    const body = stopBody.safeParse(request.body ?? {})
    if (!body.success) return problem(reply, 400, 'invalid-body', 'Unusable stop request.')
    try {
      return services.sessions.stop(`login:${parsed.data.accountId}`, body.data)
    } catch (error) {
      if (error instanceof NoSuchSession) return problem(reply, 404, 'no-session', 'This account has no login session.')
      throw error
    }
  })

  app.get<{ Params: { accountId: string }; Querystring: { ticket?: string } }>(
    '/api/claude/accounts/:accountId/login/terminal',
    { websocket: true },
    (socket, request) => {
      const parsed = accountParams.safeParse(request.params)
      const key = parsed.success ? `login:${parsed.data.accountId}` : ''
      const ticket = typeof request.query.ticket === 'string' ? request.query.ticket : ''
      if (key === '' || ticket === '' || !services.sessions.redeemTicket(ticket, key)) {
        socket.close(4401, 'unauthenticated')
        return
      }
      attachTerminal(socket, services.sessions, key)
    },
  )

  app.get('/api/chats', async () => ({ chats: services.chats.list() }))

  app.post('/api/chats', async (request, reply) => {
    const parsed = createChatBody.safeParse(request.body)
    if (!parsed.success) {
      return problem(reply, 400, 'invalid-body', 'That chat cannot be created as described.', describeZod(parsed.error))
    }
    const { accountId, model, effort, projectId, title, serviceConnectionIds } = parsed.data
    if (!services.accounts.validateSelection(accountId, model, effort)) {
      return problem(reply, 400, 'invalid-selection', 'That model and effort combination is not available for this account.')
    }
    const auth = await services.accounts.status(accountId)
    if (auth.state === 'login_required') {
      return problem(reply, 409, 'login-required', 'Sign in to the selected account before creating the chat.')
    }
    if (auth.state === 'unavailable') {
      return problem(reply, 503, 'chat-provider-unavailable', 'The selected chat account is not available.')
    }
    if (!await serviceSelectionAvailable(config, serviceConnectionIds)) {
      return problem(reply, 400, 'invalid-service-selection', 'One or more selected service connections are not configured.')
    }
    const release = projectId ? services.locks.tryAcquire(`project:${projectId}`) : () => undefined
    if (release === null) return problem(reply, 409, 'busy', 'This project is being changed right now.')
    try {
      let cwd = existsSync(config.sharedRoot) ? config.sharedRoot : process.cwd()
      if (projectId) {
        const project = projectDetailSchema.parse(
          await runControllerJson(config, ['project', 'show', projectId, '--json']),
        ).project
        cwd = sessionCwd(config, project.repoPaths, existsSync)
      }
      const chat = services.chats.create({
        title, accountId, model, effort: effort as Effort, projectId, cwd, serviceConnectionIds,
      })
      services.watcher.touch()
      return await reply.status(201).send({ chat })
    } finally {
      release()
    }
  })

  app.get<{ Params: { chatId: string } }>('/api/chats/:chatId', async (request, reply) => {
    const parsed = chatParams.safeParse(request.params)
    if (!parsed.success) return problem(reply, 400, 'invalid-chat-id', 'That is not a valid chat id.')
    try {
      return { chat: services.chats.get(parsed.data.chatId) }
    } catch (error) {
      if (error instanceof ChatNotFound) return problem(reply, 404, 'chat-not-found', 'No such chat.')
      throw error
    }
  })

  app.delete<{ Params: { chatId: string } }>('/api/chats/:chatId', async (request, reply) => {
    const parsed = chatParams.safeParse(request.params)
    if (!parsed.success) return problem(reply, 400, 'invalid-chat-id', 'That is not a valid chat id.')
    const chatId = parsed.data.chatId
    const release = services.locks.tryAcquire(`chat:${chatId}`)
    if (release === null) return problem(reply, 409, 'busy', 'This chat is being changed right now.')
    try {
      const chat = services.chats.delete(chatId)
      services.watcher.touch()
      return {
        deleted: {
          kind: 'chat',
          chatId: chat.chatId,
          projectId: chat.projectId,
          recoverable: true,
        },
      }
    } catch (error) {
      if (error instanceof ChatNotFound) return problem(reply, 404, 'chat-not-found', 'No such chat.')
      if (error instanceof ChatBusy) return problem(reply, 409, 'chat-busy', 'Stop this chat before deleting it.')
      throw error
    } finally {
      release()
    }
  })

  app.patch<{ Params: { chatId: string } }>('/api/chats/:chatId', async (request, reply) => {
    const params = chatParams.safeParse(request.params)
    const body = titleBody.safeParse(request.body)
    if (!params.success || !body.success) return problem(reply, 400, 'invalid-body', 'A valid chat title is required.')
    try {
      return { chat: services.chats.updateTitle(params.data.chatId, body.data.title) }
    } catch (error) {
      if (error instanceof ChatNotFound) return problem(reply, 404, 'chat-not-found', 'No such chat.')
      throw error
    }
  })

  app.patch<{ Params: { chatId: string } }>('/api/chats/:chatId/services', async (request, reply) => {
    const params = chatParams.safeParse(request.params)
    const body = serviceAccessBody.safeParse(request.body)
    if (!params.success || !body.success || !await serviceSelectionAvailable(config, body.data.serviceConnectionIds)) {
      return problem(reply, 400, 'invalid-service-selection', 'Select only configured service connections.')
    }
    try {
      const chat = services.chats.updateServiceConnections(params.data.chatId, body.data.serviceConnectionIds)
      services.watcher.touch()
      return { chat }
    } catch (error) {
      if (error instanceof ChatNotFound) return problem(reply, 404, 'chat-not-found', 'No such chat.')
      if (error instanceof ChatBusy) return problem(reply, 409, 'chat-busy', 'Stop this chat before changing its service access.')
      throw error
    }
  })

  app.post<{ Params: { chatId: string } }>('/api/chats/:chatId/messages', async (request, reply) => {
    const params = chatParams.safeParse(request.params)
    const body = messageBody.safeParse(request.body)
    if (!params.success || !body.success) return problem(reply, 400, 'invalid-body', 'A non-empty message is required.')
    try {
      return { chat: await services.chats.send(params.data.chatId, body.data.message) }
    } catch (error) {
      if (error instanceof ChatNotFound) return problem(reply, 404, 'chat-not-found', 'No such chat.')
      if (error instanceof ChatBusy) return problem(reply, 409, 'chat-busy', 'Claude is already answering this chat.')
      throw error
    }
  })

  app.post<{ Params: { chatId: string } }>('/api/chats/:chatId/attachments', async (request, reply) => {
    const params = chatParams.safeParse(request.params)
    const body = attachmentBody.safeParse(request.body)
    if (!params.success || !body.success) {
      return problem(reply, 400, 'invalid-body', 'A valid absolute path is required.')
    }
    try {
      const chat = await services.chats.addAttachment(params.data.chatId, body.data.path)
      services.watcher.touch()
      return await reply.status(201).send({ chat })
    } catch (error) {
      if (error instanceof ChatNotFound) return problem(reply, 404, 'chat-not-found', 'No such chat.')
      if (error instanceof InvalidAttachment) return problem(reply, 400, 'invalid-attachment', error.message)
      throw error
    }
  })

  app.delete<{ Params: { chatId: string; attachmentId: string } }>(
    '/api/chats/:chatId/attachments/:attachmentId',
    async (request, reply) => {
      const parsed = attachmentParams.safeParse(request.params)
      if (!parsed.success) return problem(reply, 400, 'invalid-params', 'That is not a valid attachment.')
      try {
        const chat = services.chats.removeAttachment(parsed.data.chatId, parsed.data.attachmentId)
        services.watcher.touch()
        return { chat }
      } catch (error) {
        if (error instanceof ChatNotFound) return problem(reply, 404, 'not-found', 'No such chat or attachment.')
        throw error
      }
    },
  )

  app.post<{ Params: { chatId: string } }>('/api/chats/:chatId/stop', async (request, reply) => {
    const params = chatParams.safeParse(request.params)
    const body = stopBody.safeParse(request.body ?? {})
    if (!params.success || !body.success) return problem(reply, 400, 'invalid-body', 'Unusable stop request.')
    try {
      return { chat: services.chats.stop(params.data.chatId, body.data.force) }
    } catch (error) {
      if (error instanceof ChatNotFound) return problem(reply, 404, 'chat-not-running', 'This chat is not currently running.')
      throw error
    }
  })
}
