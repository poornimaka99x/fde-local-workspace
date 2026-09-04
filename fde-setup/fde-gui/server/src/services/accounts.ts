import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { GuiConfig } from '../config'
import { sessionEnv } from './sessions'

export const ACCOUNT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/
export const EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]
export type AuthState = 'authenticated' | 'login_required' | 'external' | 'unavailable'

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
  { id: 'opus', label: 'Claude Opus', efforts: [...EFFORTS] },
  { id: 'haiku', label: 'Claude Haiku', efforts: ['auto'] },
]

export interface ClaudeAccount {
  id: string
  label: string
  profile: string
  provider: 'anthropic' | 'bedrock'
  profilePresent: boolean
  authState: AuthState
  authMethod: string | null
  models: ModelOption[]
}

interface RegistryAgent {
  label?: unknown
  kind?: unknown
  profile?: unknown
}

interface AuthResult {
  state: AuthState
  method: string | null
}

type StatusRunner = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string }>

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
      (error, stdout) => {
        if (error !== null) {
          reject(error)
          return
        }
        resolve({ stdout })
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

  constructor(
    private readonly config: GuiConfig,
    private readonly runStatus: StatusRunner = defaultStatusRunner,
  ) {}

  configured(): Omit<ClaudeAccount, 'authState' | 'authMethod'>[] {
    const found = new Map<string, { label: string; provider: 'anthropic' | 'bedrock' }>()
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
        })
      }
    } catch {
      /* No profiles yet is a valid first-run state. */
    }
    return [...found.entries()]
      .sort((a, b) => a[1].label.localeCompare(b[1].label))
      .map(([id, value]) => ({
        id,
        label: value.label,
        profile: id,
        provider: value.provider,
        profilePresent: existsSync(this.profileDirectory(id)),
        models: MODELS.map((model) => ({ ...model, efforts: [...model.efforts] })),
      }))
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
    if (!this.binaryAvailable()) return { state: 'unavailable', method: null }
    if (account.provider === 'bedrock') {
      return {
        state: account.profilePresent ? 'external' : 'unavailable',
        method: 'AWS credentials',
      }
    }
    if (!account.profilePresent) return { state: 'login_required', method: null }
    const cached = this.cache.get(id)
    if (!refresh && cached !== undefined && Date.now() - cached.at < 15_000) return cached.result
    let result: AuthResult
    try {
      const { stdout } = await this.runStatus(
        this.config.claudeBin,
        ['auth', 'status'],
        {
          cwd: this.config.sharedRoot,
          env: this.profileEnv(id),
          timeout: Math.min(this.config.controllerTimeoutMs, 10_000),
        },
      )
      const parsed = JSON.parse(stdout) as Record<string, unknown>
      const loggedIn = parsed.loggedIn === true || parsed.authenticated === true
      const method = [parsed.authMethod, parsed.method, parsed.subscriptionType]
        .find((value) => typeof value === 'string')
      result = {
        state: loggedIn ? 'authenticated' : 'login_required',
        method: typeof method === 'string' ? method : null,
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

  prepareLogin(id: string): { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } | null {
    const account = this.getConfigured(id)
    if (account === null || account.provider === 'bedrock') return null
    mkdirSync(this.profileDirectory(id), { recursive: true, mode: 0o700 })
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
    if (account === null) throw new Error('unknown Claude account')
    return {
      ...sessionEnv(this.config),
      CLAUDE_CONFIG_DIR: this.profileDirectory(account.profile),
      CLAUDE_PROFILE: account.profile,
      ...(account.provider === 'bedrock' ? { CLAUDE_CODE_USE_BEDROCK: '1' } : {}),
    }
  }

  validateSelection(id: string, model: string, effort: string): boolean {
    const account = this.getConfigured(id)
    if (account === null || !MODEL_PATTERN.test(model)) return false
    if (!EFFORTS.includes(effort as Effort)) return false
    const known = account.models.find((item) => item.id === model)
    return known === undefined || known.efforts.includes(effort as Effort)
  }

  binaryAvailable(): boolean {
    if (path.isAbsolute(this.config.claudeBin)) return existsSync(this.config.claudeBin)
    return (process.env.PATH ?? '/usr/bin:/bin')
      .split(path.delimiter)
      .some((directory) => existsSync(path.join(directory, this.config.claudeBin)))
  }

  private profileDirectory(id: string): string {
    return path.join(this.config.profilesRoot, id)
  }
}
