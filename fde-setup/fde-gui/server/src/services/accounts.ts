import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { GuiConfig } from '../config'
import { sessionEnv } from './sessions'

export const ACCOUNT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/
export const EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type Effort = (typeof EFFORTS)[number]
export type AuthState = 'authenticated' | 'login_required' | 'external' | 'unavailable'
export type ChatProvider = 'anthropic' | 'bedrock' | 'codex'

/** The capability the registry requires of a design-panel participant. */
export const DESIGN_CAPABILITY = 'ui-ux-design'

/**
 * How, if at all, the installed CLI can be given a file or image.
 *
 * Feature detection, not assumption: an image is never turned into prompt text,
 * so if the CLI on this machine documents no way to take a file, a panel that
 * selected one is refused before anything starts.
 */
export interface MediaSupport {
  support: 'file' | 'none'
  flag: string | null
}

const MEDIA_FLAGS = ['--attach', '--add-file', '--image', '--file'] as const

/**
 * The profile directory could not be created or verified before starting a
 * login terminal. This is always surfaced to the caller rather than left to
 * bubble into the generic 500 handler, which deliberately hides the real
 * cause from the response body.
 */
export class ProfileDirectoryError extends Error {
  constructor(readonly accountId: string, readonly directory: string, readonly sourceError: unknown) {
    const reason = sourceError instanceof Error ? sourceError.message : String(sourceError)
    super(`could not prepare profile directory for '${accountId}' at ${directory}: ${reason}`)
  }
}

export interface ModelOption {
  id: string
  label: string
  efforts: Effort[]
}

const MODELS: ModelOption[] = [
  // The account default may currently resolve to Sonnet or Opus. xhigh is
  // Opus-specific, so it is offered only when the operator explicitly picks
  // Opus; this avoids relying on Claude's silent effort downgrade.
  { id: 'default', label: 'Account default', efforts: ['auto', 'low', 'medium', 'high', 'max'] },
  { id: 'sonnet', label: 'Claude Sonnet', efforts: ['auto', 'low', 'medium', 'high', 'max'] },
  { id: 'opus', label: 'Claude Opus', efforts: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'haiku', label: 'Claude Haiku', efforts: ['auto'] },
]

const CODEX_MODELS: ModelOption[] = [
  { id: 'default', label: 'Account default', efforts: [...EFFORTS] },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.2', label: 'GPT-5.2', efforts: ['low', 'medium', 'high', 'xhigh'] },
]

const BEDROCK_ENV_ALLOWLIST = new Set([
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
])

export interface ClaudeAccount {
  id: string
  label: string
  profile: string
  provider: ChatProvider
  profilePresent: boolean
  authState: AuthState
  authMethod: string | null
  models: ModelOption[]
  /** Registry capabilities, verbatim. Identities are not roles; this is what an
   *  identity is *allowed to be given*, and the run still decides who does what. */
  capabilities: string[]
  /** Eligible to be a design-panel participant: a Claude account the registry
   *  says may hold the uiUxDesign role. */
  designPanelEligible: boolean
}

interface RegistryAgent {
  label?: unknown
  kind?: unknown
  profile?: unknown
  capabilities?: unknown
}

interface AuthResult {
  state: AuthState
  method: string | null
}

type StatusRunner = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string; stderr: string }>

const defaultStatusRunner: StatusRunner = async (file, args, options) =>
  await new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeout,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(error)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })

/**
 * Safe metadata about configured Claude identities. Credential files are never
 * opened here: Claude Code itself reports whether its selected profile is
 * authenticated.
 */
export class AccountService {
  private readonly cache = new Map<string, { at: number; result: AuthResult }>()
  private media: { at: number; result: MediaSupport } | null = null

  constructor(
    private readonly config: GuiConfig,
    private readonly runStatus: StatusRunner = defaultStatusRunner,
  ) {}

  configured(): Omit<ClaudeAccount, 'authState' | 'authMethod'>[] {
    const found = new Map<string, {
      label: string
      provider: Exclude<ChatProvider, 'codex'>
      capabilities: string[]
    }>()
    try {
      const raw = JSON.parse(
        readFileSync(path.join(this.config.sharedRoot, 'config', 'agents.json'), 'utf8'),
      ) as { agents?: Record<string, RegistryAgent> }
      for (const agent of Object.values(raw.agents ?? {})) {
        if (agent.kind !== 'claude' || typeof agent.profile !== 'string') continue
        const id = agent.profile
        if (!ACCOUNT_ID_PATTERN.test(id)) continue
        found.set(id, {
          label: typeof agent.label === 'string' ? agent.label : `Claude: ${id}`,
          provider: id === 'bedrock' ? 'bedrock' : 'anthropic',
          capabilities: Array.isArray(agent.capabilities)
            ? agent.capabilities.filter((value): value is string => typeof value === 'string')
            : [],
        })
      }
    } catch {
      /* A partial installation can still expose profile directories by name. */
    }
    try {
      for (const entry of readdirSync(this.config.profilesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !ACCOUNT_ID_PATTERN.test(entry.name) || found.has(entry.name)) continue
        found.set(entry.name, {
          label: `Claude: ${entry.name}`,
          provider: entry.name === 'bedrock' ? 'bedrock' : 'anthropic',
          // A profile directory with no registry entry is an identity the
          // operator created but has not described. It can log in; it cannot be
          // given a role it was never granted.
          capabilities: [],
        })
      }
    } catch {
      /* No profiles yet is a valid first-run state. */
    }
    const claudeAccounts = [...found.entries()]
      .sort((a, b) => a[1].label.localeCompare(b[1].label))
      .map(([id, value]) => ({
        id,
        label: value.label,
        profile: id,
        provider: value.provider,
        profilePresent: existsSync(this.profileDirectory(id)),
        models: MODELS.map((model) => ({ ...model, efforts: [...model.efforts] })),
        capabilities: [...value.capabilities],
        designPanelEligible: value.capabilities.includes(DESIGN_CAPABILITY),
      }))
    return [
      ...claudeAccounts,
      {
        id: 'codex',
        label: 'ChatGPT / Codex',
        profile: 'codex',
        provider: 'codex' as const,
        profilePresent: existsSync(path.join(this.config.home, '.codex')),
        models: CODEX_MODELS.map((model) => ({ ...model, efforts: [...model.efforts] })),
        capabilities: [],
        // A design panel is about separately authenticated *Claude* accounts
        // reading the same sealed context. Codex is not one of them.
        designPanelEligible: false,
      },
    ]
  }

  async list(refresh = false): Promise<ClaudeAccount[]> {
    return await Promise.all(this.configured().map(async (account) => {
      const status = await this.status(account.id, refresh)
      return {
        ...account,
        authState: status.state,
        authMethod: status.method,
      }
    }))
  }

  getConfigured(id: string): Omit<ClaudeAccount, 'authState' | 'authMethod'> | null {
    return this.configured().find((account) => account.id === id) ?? null
  }

  async status(id: string, refresh = false): Promise<AuthResult> {
    const account = this.getConfigured(id)
    if (account === null) return { state: 'unavailable', method: null }
    if (!this.binaryAvailable(account.provider)) return { state: 'unavailable', method: null }
    if (account.provider === 'bedrock') {
      return {
        state: account.profilePresent ? 'external' : 'unavailable',
        method: 'AWS credentials',
      }
    }
    if (account.provider !== 'codex' && !account.profilePresent) return { state: 'login_required', method: null }
    const cached = this.cache.get(id)
    if (!refresh && cached !== undefined && Date.now() - cached.at < 15_000) return cached.result
    let result: AuthResult
    try {
      const { stdout, stderr } = await this.runStatus(
        account.provider === 'codex' ? this.config.codexBin : this.config.claudeBin,
        account.provider === 'codex' ? ['login', 'status'] : ['auth', 'status'],
        {
          cwd: this.config.sharedRoot,
          env: this.profileEnv(id),
          timeout: Math.min(this.config.controllerTimeoutMs, 10_000),
        },
      )
      if (account.provider === 'codex') {
        const statusText = `${stdout}\n${stderr}`
        const loggedIn = /logged in/i.test(statusText)
        result = {
          state: loggedIn ? 'authenticated' : 'login_required',
          method: loggedIn && /chatgpt/i.test(statusText) ? 'ChatGPT' : null,
        }
      } else {
        const parsed = JSON.parse(stdout) as Record<string, unknown>
        const loggedIn = parsed.loggedIn === true || parsed.authenticated === true
        const method = [parsed.authMethod, parsed.method, parsed.subscriptionType]
          .find((value) => typeof value === 'string')
        result = {
          state: loggedIn ? 'authenticated' : 'login_required',
          method: typeof method === 'string' ? method : null,
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      result = code === 'ENOENT'
        ? { state: 'unavailable', method: null }
        : { state: 'login_required', method: null }
    }
    this.cache.set(id, { at: Date.now(), result })
    return result
  }

  /**
   * What the installed Claude CLI can be handed as a file, detected once.
   *
   * Binary bytes never become prompt text, so this answer decides whether a
   * panel that selected an image may start at all.
   */
  async mediaSupport(refresh = false): Promise<MediaSupport> {
    if (!refresh && this.media !== null && Date.now() - this.media.at < 300_000) {
      return this.media.result
    }
    let result: MediaSupport = { support: 'none', flag: null }
    if (this.binaryAvailable('anthropic')) {
      try {
        const { stdout, stderr } = await this.runStatus(this.config.claudeBin, ['--help'], {
          cwd: this.config.sharedRoot,
          env: sessionEnv(this.config),
          timeout: Math.min(this.config.controllerTimeoutMs, 10_000),
        })
        const help = `${stdout}\n${stderr}`
        const flag = MEDIA_FLAGS.find((candidate) =>
          new RegExp(`(^|\\s)${candidate}(\\s|=|,)`).test(help))
        if (flag !== undefined) result = { support: 'file', flag }
      } catch {
        /* A CLI that cannot be asked is a CLI that cannot take a file. */
      }
    }
    this.media = { at: Date.now(), result }
    return result
  }

  prepareLogin(id: string): { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } | null {
    const account = this.getConfigured(id)
    if (account === null || account.provider === 'bedrock') return null
    if (account.provider === 'codex') {
      this.cache.delete(id)
      return {
        file: this.config.codexBin,
        args: ['login'],
        cwd: this.config.sharedRoot,
        env: this.profileEnv(id),
      }
    }
    const directory = this.profileDirectory(id)
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new ProfileDirectoryError(id, directory, error)
    }
    this.cache.delete(id)
    return {
      file: this.config.claudeBin,
      args: ['auth', 'login'],
      cwd: this.config.sharedRoot,
      env: this.profileEnv(id),
    }
  }

  profileEnv(id: string): NodeJS.ProcessEnv {
    const account = this.getConfigured(id)
    if (account === null) throw new Error('unknown chat account')
    if (account.provider === 'codex') return sessionEnv(this.config)
    return {
      ...sessionEnv(this.config),
      CLAUDE_CONFIG_DIR: this.profileDirectory(account.profile),
      CLAUDE_PROFILE: account.profile,
      ...(account.provider === 'bedrock'
        ? {
            ...this.bedrockProfileEnv(account.profile),
            CLAUDE_CODE_USE_BEDROCK: '1',
            AWS_SDK_LOAD_CONFIG: '1',
          }
        : {}),
    }
  }

  validateSelection(id: string, model: string, effort: string): boolean {
    const account = this.getConfigured(id)
    if (account === null || !MODEL_PATTERN.test(model)) return false
    if (!EFFORTS.includes(effort as Effort)) return false
    const known = account.models.find((item) => item.id === model)
    return known === undefined || known.efforts.includes(effort as Effort)
  }

  binaryAvailable(provider: ChatProvider = 'anthropic'): boolean {
    const binary = provider === 'codex' ? this.config.codexBin : this.config.claudeBin
    if (path.isAbsolute(binary)) return existsSync(binary)
    return (process.env.PATH ?? '/usr/bin:/bin')
      .split(path.delimiter)
      .some((directory) => existsSync(path.join(directory, binary)))
  }

  /** Read only non-secret Bedrock routing values from the selected profile. */
  private bedrockProfileEnv(id: string): NodeJS.ProcessEnv {
    try {
      const settings = JSON.parse(
        readFileSync(path.join(this.profileDirectory(id), 'settings.json'), 'utf8'),
      ) as { env?: Record<string, unknown> }
      const safe: NodeJS.ProcessEnv = {}
      for (const [name, value] of Object.entries(settings.env ?? {})) {
        if (!BEDROCK_ENV_ALLOWLIST.has(name) || typeof value !== 'string') continue
        if (value.length === 0 || value.length > 1024 || value.includes('\0')) continue
        safe[name] = value
      }
      return safe
    } catch {
      return {}
    }
  }

  private profileDirectory(id: string): string {
    return path.join(this.config.profilesRoot, id)
  }
}
