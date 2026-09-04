import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { authed, makeHarness, type Harness } from './harness'
import { FakeTerminal, fakeSpawn } from './fake-terminal'
import { AccountService } from '../../server/src/services/accounts'
import { ChatService, type ChatCommandRunner } from '../../server/src/services/chats'

function mutating(token: string): Record<string, string> {
  return { ...authed(token), origin: 'http://127.0.0.1:7317', 'content-type': 'application/json' }
}

describe('Claude accounts and general chats', () => {
  let harness: Harness

  beforeEach(async () => {
    FakeTerminal.spawned = []
    harness = await makeHarness({ spawnTerminal: fakeSpawn })
  })
  afterEach(async () => harness.destroy())

  it('lists safe account metadata and model-specific effort choices', async () => {
    const response = await harness.app.inject({
      method: 'GET', url: '/api/claude/accounts', headers: authed(harness.token),
    })
    expect(response.statusCode).toBe(200)
    const account = response.json().accounts.find((item: { id: string }) => item.id === 'work')
    expect(account).toMatchObject({
      id: 'work', profile: 'work', authState: 'authenticated', authMethod: 'test-subscription',
    })
    expect(account.models.find((item: { id: string }) => item.id === 'haiku').efforts).toEqual(['auto'])
    expect(response.payload).not.toContain('.credentials.json')
    expect(response.payload).not.toContain(harness.token)
  })

  it('starts exactly the selected profile login command in an isolated PTY', async () => {
    const response = await harness.app.inject({
      method: 'POST', url: '/api/claude/accounts/work/login',
      headers: mutating(harness.token), payload: {},
    })
    expect(response.statusCode).toBe(201)
    expect(FakeTerminal.spawned).toHaveLength(1)
    expect(FakeTerminal.spawned[0]?.options.file).toBe(harness.config.claudeBin)
    expect(FakeTerminal.spawned[0]?.options.args).toEqual(['auth', 'login'])
    expect(FakeTerminal.spawned[0]?.options.env.CLAUDE_PROFILE).toBe('work')
    expect(FakeTerminal.spawned[0]?.options.env.USER).toBeTruthy()
    expect(FakeTerminal.spawned[0]?.options.env.CLAUDE_CONFIG_DIR).toBe(
      path.join(harness.config.profilesRoot, 'work'),
    )
    expect(response.payload).not.toContain('.credentials.json')
    expect(response.payload).not.toContain(harness.token)
  })

  it('creates a durable chat and resumes the same opaque Claude conversation', async () => {
    const created = await harness.app.inject({
      method: 'POST', url: '/api/chats', headers: mutating(harness.token),
      payload: { accountId: 'work', model: 'sonnet', effort: 'high' },
    })
    expect(created.statusCode).toBe(201)
    const chatId = created.json().chat.chatId as string

    const answered = await harness.app.inject({
      method: 'POST', url: `/api/chats/${chatId}/messages`, headers: mutating(harness.token),
      payload: { message: 'Explain the deployment boundary.' },
    })
    expect(answered.statusCode).toBe(200)
    expect(answered.json().chat.messages).toMatchObject([
      { role: 'user', content: 'Explain the deployment boundary.' },
      { role: 'assistant', content: 'Claude reply: Explain the deployment boundary.' },
    ])
    const stored = path.join(harness.config.chatsRoot, `${chatId}.json`)
    expect(JSON.parse(readFileSync(stored, 'utf8')).claudeSessionId).toBe(created.json().chat.claudeSessionId)
    expect(statSync(stored).mode & 0o077).toBe(0)
  })

  it('rejects unsupported effort choices and path-shaped account ids', async () => {
    const badEffort = await harness.app.inject({
      method: 'POST', url: '/api/chats', headers: mutating(harness.token),
      payload: { accountId: 'work', model: 'haiku', effort: 'max' },
    })
    expect(badEffort.statusCode).toBe(400)
    expect(badEffort.json()).toMatchObject({ type: 'about:fde/invalid-selection' })

    const badAccount = await harness.app.inject({
      method: 'POST', url: '/api/chats', headers: mutating(harness.token),
      payload: { accountId: '../work', model: 'default', effort: 'auto' },
    })
    expect(badAccount.statusCode).toBe(400)
  })

  it('launches chat without a shell, tools, plugins, Chrome or slash commands', async () => {
    const calls: Parameters<ChatCommandRunner>[0][] = []
    const runner: ChatCommandRunner = (options) => {
      calls.push(options)
      const flag = options.args.includes('--session-id') ? '--session-id' : '--resume'
      const session = options.args[options.args.indexOf(flag) + 1]
      return {
        completed: Promise.resolve({ code: 0, stdout: JSON.stringify({ result: 'safe reply', session_id: session }) }),
        kill: () => undefined,
      }
    }
    const accountsService = new AccountService(harness.config)
    const chats = new ChatService(harness.config, accountsService, runner)
    const chat = chats.create({ accountId: 'work', model: 'opus', effort: 'xhigh', cwd: harness.root })
    await chats.send(chat.chatId, 'First')
    await chats.send(chat.chatId, 'Second')

    expect(calls[0]?.file).toBe(harness.config.claudeBin)
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      '--print', 'First', '--tools', '', '--permission-mode', 'plan', '--bare',
      '--no-chrome', '--disable-slash-commands', '--model', 'opus', '--effort', 'xhigh',
      '--session-id', chat.claudeSessionId,
    ]))
    expect(calls[1]?.args).toEqual(expect.arrayContaining(['--resume', chat.claudeSessionId]))
  })
})
