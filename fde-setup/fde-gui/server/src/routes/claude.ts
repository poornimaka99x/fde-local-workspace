import { existsSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import type WebSocket from 'ws'
import { z } from 'zod'
import type { GuiConfig } from '../config'
import { problem } from '../problem'
import { projectDetailSchema } from '../schemas/controller'
import { block, describeZod, line } from '../schemas/input'
import { ACCOUNT_ID_PATTERN, EFFORTS, MODEL_PATTERN, type Effort } from '../services/accounts'
import { ChatBusy, CHAT_ID_PATTERN, ChatNotFound } from '../services/chats'
import { PROJECT_ID_PATTERN, runControllerJson } from '../services/controller'
import { NoSuchSession, SessionExists, sessionCwd } from '../services/sessions'
import type { Services } from '../services/types'

const accountParams = z.object({ accountId: z.string().regex(ACCOUNT_ID_PATTERN) })
const chatParams = z.object({ chatId: z.string().regex(CHAT_ID_PATTERN) })
const createChatBody = z.object({
  title: line(120).optional(),
  accountId: z.string().regex(ACCOUNT_ID_PATTERN),
  model: z.string().regex(MODEL_PATTERN).default('default'),
  effort: z.enum(EFFORTS).default('auto'),
  projectId: z.string().regex(PROJECT_ID_PATTERN).nullable().optional(),
})
const messageBody = z.object({ message: block(20_000).transform((value) => value.trim()).pipe(z.string().min(1)) })
const titleBody = z.object({ title: line(120).transform((value) => value.trim()).pipe(z.string().min(1)) })
const stopBody = z.object({ force: z.boolean().default(false) }).default({ force: false })

function attachTerminal(
  socket: WebSocket,
  sessions: Services['sessions'],
  key: string,
): void {
  const send = (payload: unknown): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload))
  }
  let attached: { detach: () => void } | null = null
  try {
    const attachment = sessions.attach(
      key,
      (chunk) => send({ type: 'output', data: chunk }),
      (exitCode) => send({ type: 'exit', exitCode }),
    )
    attached = attachment
    send({ type: 'ready', session: attachment.view, backlog: attachment.backlog })
  } catch {
    socket.close(4404, 'no session')
    return
  }
  socket.on('message', (raw: Buffer) => {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    } catch {
      return
    }
    if (message.type === 'input' && typeof message.data === 'string') {
      try {
        sessions.write(key, message.data)
      } catch {
        send({ type: 'exit', exitCode: sessions.get(key)?.exitCode ?? 0 })
      }
      return
    }
    if (message.type === 'resize' && typeof message.cols === 'number' && typeof message.rows === 'number') {
      sessions.resize(key, Math.floor(message.cols), Math.floor(message.rows))
    }
  })
  socket.on('close', () => attached?.detach())
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
      return problem(reply, 404, 'account-not-found', 'That Claude account is not configured.')
    }
    return await services.accounts.status(parsed.data.accountId, true)
  })

  app.post<{ Params: { accountId: string } }>('/api/claude/accounts/:accountId/login', async (request, reply) => {
    const parsed = accountParams.safeParse(request.params)
    if (!parsed.success) return problem(reply, 400, 'invalid-account', 'That account id is not valid.')
    const account = services.accounts.getConfigured(parsed.data.accountId)
    if (account === null) return problem(reply, 404, 'account-not-found', 'That Claude account is not configured.')
    if (account.provider === 'bedrock') {
      return problem(reply, 409, 'external-auth', 'Bedrock authentication is managed through AWS credentials.')
    }
    if (!services.accounts.binaryAvailable()) {
      return problem(reply, 503, 'claude-unavailable', 'The Claude CLI is not available to this console.')
    }
    if (!services.sessions.available) {
      return problem(reply, 503, 'terminal-unavailable', 'Interactive login needs the terminal backend.')
    }
    const key = `login:${account.id}`
    if (services.sessions.isRunning(key)) {
      return { status: 'existing', session: services.sessions.get(key), ticket: services.sessions.issueTicket(key) }
    }
    const spec = services.accounts.prepareLogin(account.id)
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
    const { accountId, model, effort, projectId, title } = parsed.data
    if (!services.accounts.validateSelection(accountId, model, effort)) {
      return problem(reply, 400, 'invalid-selection', 'That model and effort combination is not available for this account.')
    }
    const auth = await services.accounts.status(accountId)
    if (auth.state === 'login_required') {
      return problem(reply, 409, 'login-required', 'Sign in to this Claude account before creating the chat.')
    }
    if (auth.state === 'unavailable') {
      return problem(reply, 503, 'claude-unavailable', 'The selected Claude account is not available.')
    }
    let cwd = existsSync(config.sharedRoot) ? config.sharedRoot : process.cwd()
    if (projectId) {
      const project = projectDetailSchema.parse(
        await runControllerJson(config, ['project', 'show', projectId, '--json']),
      ).project
      cwd = sessionCwd(config, project.repoPaths, existsSync)
    }
    const chat = services.chats.create({ title, accountId, model, effort: effort as Effort, projectId, cwd })
    services.watcher.touch()
    return await reply.status(201).send({ chat })
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
