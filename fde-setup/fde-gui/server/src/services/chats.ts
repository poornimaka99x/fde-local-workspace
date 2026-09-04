import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { GuiConfig } from '../config'
import type { AccountService, Effort } from './accounts'

export const CHAT_ID_PATTERN = /^chat-[0-9]{8}-[a-f0-9]{8}$/

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export interface ChatRecord {
  schemaVersion: 1
  chatId: string
  title: string
  accountId: string
  profile: string
  provider: 'anthropic' | 'bedrock'
  model: string
  effort: Effort
  projectId: string | null
  cwd: string
  claudeSessionId: string
  createdAt: string
  updatedAt: string
  status: 'idle' | 'running' | 'failed'
  lastError: string | null
  messages: ChatMessage[]
}

export interface ChatSummary extends Omit<ChatRecord, 'messages'> {
  messageCount: number
  lastMessage: string | null
}

export interface CommandResult {
  code: number
  stdout: string
}

export interface RunningCommand {
  completed: Promise<CommandResult>
  kill(signal: NodeJS.Signals): void
}

export type ChatCommandRunner = (options: {
  file: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}) => RunningCommand

const defaultRunner: ChatCommandRunner = (options) => {
  const child = spawn(options.file, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    if (stdout.length < 8 * 1024 * 1024) stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 128 * 1024) stderr += chunk
  })
  const completed = new Promise<CommandResult>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? 1, stdout: stdout || stderr }))
  })
  return { completed, kill: (signal) => child.kill(signal) }
}

export class ChatBusy extends Error {}
export class ChatNotFound extends Error {}

/** Durable chat metadata and messages; Claude owns the opaque conversation id. */
export class ChatService {
  private readonly active = new Map<string, RunningCommand>()

  constructor(
    private readonly config: GuiConfig,
    private readonly accounts: AccountService,
    private readonly runCommand: ChatCommandRunner = defaultRunner,
  ) {}

  list(): ChatSummary[] {
    let entries: string[] = []
    try {
      entries = readdirSync(this.config.chatsRoot)
    } catch {
      return []
    }
    return entries
      .filter((name) => CHAT_ID_PATTERN.test(name))
      .map((id) => {
        try {
          return this.summary(this.read(id))
        } catch {
          return null
        }
      })
      .filter((chat): chat is ChatSummary => chat !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(chatId: string): ChatRecord {
    const chat = this.read(chatId)
    return { ...chat, status: this.active.has(chatId) ? 'running' : chat.status }
  }

  create(input: {
    title?: string
    accountId: string
    model: string
    effort: Effort
    projectId?: string | null
    cwd: string
  }): ChatRecord {
    const account = this.accounts.getConfigured(input.accountId)
    if (account === null) throw new Error('unknown Claude account')
    const chatId = `chat-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(4).toString('hex')}`
    const now = new Date().toISOString()
    const chat: ChatRecord = {
      schemaVersion: 1,
      chatId,
      title: input.title?.trim() || 'New chat',
      accountId: account.id,
      profile: account.profile,
      provider: account.provider,
      model: input.model,
      effort: input.effort,
      projectId: input.projectId ?? null,
      cwd: input.cwd,
      claudeSessionId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      lastError: null,
      messages: [],
    }
    this.write(chat)
    return chat
  }

  updateTitle(chatId: string, title: string): ChatRecord {
    const chat = this.read(chatId)
    chat.title = title.trim()
    chat.updatedAt = new Date().toISOString()
    this.write(chat)
    return chat
  }

  async send(chatId: string, prompt: string): Promise<ChatRecord> {
    if (this.active.has(chatId)) throw new ChatBusy(chatId)
    const chat = this.read(chatId)
    const firstTurn = !chat.messages.some((message) => message.role === 'assistant')
    const now = new Date().toISOString()
    chat.messages.push({ id: randomUUID(), role: 'user', content: prompt, createdAt: now })
    if (chat.title === 'New chat') chat.title = prompt.trim().replace(/\s+/g, ' ').slice(0, 80)
    chat.updatedAt = now
    chat.status = 'running'
    chat.lastError = null
    this.write(chat)

    const args = [
      '--print', prompt,
      '--output-format', 'json',
      '--permission-mode', 'plan',
      '--tools', '',
      '--bare',
      '--no-chrome',
      '--disable-slash-commands',
    ]
    if (firstTurn) args.push('--session-id', chat.claudeSessionId)
    else args.push('--resume', chat.claudeSessionId)
    if (chat.model !== 'default') args.push('--model', chat.model)
    if (chat.effort !== 'auto') args.push('--effort', chat.effort)

    const command = this.runCommand({
      file: this.config.claudeBin,
      args,
      cwd: chat.cwd,
      env: this.accounts.profileEnv(chat.accountId),
    })
    this.active.set(chatId, command)
    try {
      const result = await command.completed
      const latest = this.read(chatId)
      if (result.code !== 0) {
        latest.status = 'failed'
        latest.lastError = 'Claude did not complete this message. Check the selected account login and try again.'
        latest.updatedAt = new Date().toISOString()
        this.write(latest)
        return latest
      }
      let content = result.stdout.trim()
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>
        if (typeof parsed.result === 'string') content = parsed.result
        if (typeof parsed.session_id === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(parsed.session_id)) {
          latest.claudeSessionId = parsed.session_id
        }
      } catch {
        // Older compatible Claude CLIs may emit plain text. It is still inert
        // content and is rendered as text/markdown, never as HTML.
      }
      latest.messages.push({
        id: randomUUID(),
        role: 'assistant',
        content: content.slice(0, 2 * 1024 * 1024),
        createdAt: new Date().toISOString(),
      })
      latest.status = 'idle'
      latest.lastError = null
      latest.updatedAt = new Date().toISOString()
      this.write(latest)
      return latest
    } catch {
      const latest = this.read(chatId)
      latest.status = 'failed'
      latest.lastError = 'Claude could not be started for this account.'
      latest.updatedAt = new Date().toISOString()
      this.write(latest)
      return latest
    } finally {
      this.active.delete(chatId)
    }
  }

  stop(chatId: string, force = false): ChatRecord {
    const command = this.active.get(chatId)
    if (command === undefined) throw new ChatNotFound(chatId)
    command.kill(force ? 'SIGKILL' : 'SIGINT')
    return this.get(chatId)
  }

  shutdown(): void {
    for (const command of this.active.values()) {
      try {
        command.kill('SIGHUP')
      } catch {
        /* already gone */
      }
    }
    this.active.clear()
  }

  private read(chatId: string): ChatRecord {
    if (!CHAT_ID_PATTERN.test(chatId)) throw new ChatNotFound(chatId)
    try {
      const parsed = JSON.parse(readFileSync(this.file(chatId), 'utf8')) as ChatRecord
      if (parsed.chatId !== chatId || parsed.schemaVersion !== 1 || !Array.isArray(parsed.messages)) {
        throw new Error('malformed chat')
      }
      return parsed
    } catch {
      throw new ChatNotFound(chatId)
    }
  }

  private write(chat: ChatRecord): void {
    mkdirSync(this.config.chatsRoot, { recursive: true, mode: 0o700 })
    const target = this.file(chat.chatId)
    const temporary = `${target}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(chat, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, target)
  }

  private file(chatId: string): string {
    return path.join(this.config.chatsRoot, `${chatId}.json`)
  }

  private summary(chat: ChatRecord): ChatSummary {
    const { messages, ...rest } = chat
    return {
      ...rest,
      status: this.active.has(chat.chatId) ? 'running' : chat.status,
      messageCount: messages.length,
      lastMessage: messages.at(-1)?.content.slice(0, 160) ?? null,
    }
  }
}
