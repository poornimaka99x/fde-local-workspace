import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { GuiConfig } from '../config'
import type { AccountService } from './accounts'
import type { ChangeWatcher } from './watch'
import { ControllerError, runControllerJson, runControllerWithStdin } from './controller'
import {
  lensListSchema,
  packListSchema,
  panelContextSchema,
  panelEnvelopeSchema,
  panelReconcileStartSchema,
  panelStartSchema,
  referenceCatalogSchema,
  type LensList,
  type PackList,
  type PanelView,
  type ReferenceCatalog,
} from '../schemas/design-panel'

/**
 * Running a design panel, without becoming a second workflow engine.
 *
 * The controller owns every fact: who the participants are, what context they
 * share, which of them may start, and what was produced. This service does one
 * thing the controller cannot — it runs the accounts — and it does it under the
 * console's existing rules:
 *
 *   - one profile's environment, from `AccountService.profileEnv()`, never merged
 *     with another's and never read for its contents;
 *   - an argument array with `shell: false`, no caller-supplied executable, flag
 *     list, environment or output path;
 *   - a wall-clock timeout, an output ceiling, explicit cancellation, and a
 *     hard concurrency limit;
 *   - nothing logged but an exit code. Prompts, attached material, model output
 *     and authentication text never reach a log line.
 */

export interface RunningPanelCommand {
  completed: Promise<{ code: number; stdout: string }>
  kill(signal: NodeJS.Signals): void
}

export type PanelCommandRunner = (options: {
  file: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}) => RunningPanelCommand

const defaultRunner: PanelCommandRunner = (options) => {
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
  const completed = new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? 1, stdout: stdout || stderr }))
  })
  return { completed, kill: (signal) => child.kill(signal) }
}

export class PanelBusy extends Error {}
export class PanelUnavailable extends Error {}

export interface PanelParticipantSelection {
  accountId: string
  model: string
  effort: string
  lensId: string
  lens?: string
}

export interface PanelCreateInput {
  brief: string
  participants: PanelParticipantSelection[]
  mode: string
  outputTarget: string
  attachmentIds: string[]
  includeProductMd: boolean
  includeDesignMd: boolean
  referenceIds: string[]
  packs: Record<string, Record<string, number>>
  acknowledgePackConflict: boolean
  proposePlan: boolean
}

interface CachedCatalog<T> {
  at: number
  value: T
}

const CATALOG_TTL_MS = 60_000

export class DesignPanelService {
  /**
   * Every process slot this console has spent, keyed `runId:participantId`.
   *
   * A slot is taken *before* the controller is asked for a prompt, and holds
   * `null` until the process behind it exists. Checking the limit and then
   * awaiting would let two requests that arrived together both pass the check
   * and both take a process; the reservation is what makes the limit a limit
   * rather than a hint. `shutdown()` and `stopParticipant()` therefore have to
   * tolerate a slot with nothing running in it yet.
   */
  private readonly active = new Map<string, RunningPanelCommand | null>()
  private readonly deletingRuns = new Set<string>()
  private references: CachedCatalog<ReferenceCatalog> | null = null
  private packs: CachedCatalog<PackList> | null = null
  private lenses: CachedCatalog<LensList> | null = null

  constructor(
    private readonly config: GuiConfig,
    private readonly accounts: AccountService,
    private readonly watcher: ChangeWatcher,
    private readonly runCommand: PanelCommandRunner = defaultRunner,
  ) {}

  // -- catalogs the browser may choose from -------------------------------

  async referenceCatalog(): Promise<ReferenceCatalog> {
    if (this.references !== null && Date.now() - this.references.at < CATALOG_TTL_MS) {
      return this.references.value
    }
    const value = referenceCatalogSchema.parse(
      await runControllerJson(this.config, ['design-panel', 'references', '--json']),
    )
    this.references = { at: Date.now(), value }
    return value
  }

  async packCatalog(): Promise<PackList> {
    if (this.packs !== null && Date.now() - this.packs.at < CATALOG_TTL_MS) {
      return this.packs.value
    }
    const value = packListSchema.parse(
      await runControllerJson(this.config, ['design-panel', 'packs', '--json']),
    )
    this.packs = { at: Date.now(), value }
    return value
  }

  async lensCatalog(): Promise<LensList> {
    if (this.lenses !== null && Date.now() - this.lenses.at < CATALOG_TTL_MS) {
      return this.lenses.value
    }
    const value = lensListSchema.parse(
      await runControllerJson(this.config, ['design-panel', 'lenses', '--json']),
    )
    this.lenses = { at: Date.now(), value }
    return value
  }

  // -- reads ---------------------------------------------------------------

  /**
   * The panel as the controller sees it.
   *
   * A participant the controller still calls `running` with no process behind it
   * in this server is an orphan from a previous launch. It is turned into a
   * retryable interruption rather than left spinning forever on the screen.
   */
  async view(runId: string): Promise<PanelView> {
    let panel = await this.show(runId)
    const orphaned = panel.participants.some((participant) => participant.state === 'running')
    const reconciling = String((panel.reconciliation as { state?: unknown }).state ?? '') === 'running'
    if ((orphaned || reconciling) && !this.hasActiveWork(runId)) {
      await runControllerJson(this.config, ['design-panel', 'recover', runId, '--json'])
      this.watcher.touch()
      panel = await this.show(runId)
    }
    return panel
  }

  async context(runId: string): Promise<unknown> {
    return panelContextSchema.parse(
      await runControllerJson(this.config, ['design-panel', 'context', runId, '--json']),
    )
  }

  private async show(runId: string): Promise<PanelView> {
    const raw = await runControllerJson(this.config, ['design-panel', 'show', runId, '--json'])
    return panelEnvelopeSchema.parse(raw).designPanel
  }

  private hasActiveWork(runId: string): boolean {
    for (const key of this.active.keys()) {
      if (key.startsWith(`${runId}:`)) return true
    }
    return false
  }

  /** Reserve a run against new panel work while its controller record moves. */
  beginRunDeletion(runId: string): (() => void) | null {
    if (this.deletingRuns.has(runId) || this.hasActiveWork(runId)) return null
    this.deletingRuns.add(runId)
    return () => this.deletingRuns.delete(runId)
  }

  isRunning(runId: string, participantId: string): boolean {
    return this.active.has(`${runId}:${participantId}`)
  }

  // -- mutations -----------------------------------------------------------

  async create(runId: string, input: PanelCreateInput): Promise<PanelView> {
    const media = await this.accounts.mediaSupport()
    const args = ['design-panel', 'create', runId, '--brief-stdin', '--json',
      '--mode', input.mode, '--output', input.outputTarget,
      '--media-support', media.support]
    for (const participant of input.participants) {
      args.push('--participant',
        `${participant.accountId}:${participant.lensId}:${participant.effort}:${participant.model}`)
      if (participant.lens !== undefined && participant.lens.trim() !== '') {
        // The controller names participants by identity, which it derives from
        // the account. The lens override is keyed the same way.
        args.push('--lens', `claude_${participant.accountId}=${participant.lens.trim()}`)
      }
    }
    for (const attachmentId of input.attachmentIds) args.push('--attachment', attachmentId)
    if (input.includeProductMd) args.push('--include-product-md')
    if (input.includeDesignMd) args.push('--include-design-md')
    for (const reference of input.referenceIds) args.push('--reference', reference)
    for (const [packId, options] of Object.entries(input.packs)) {
      const dials = Object.entries(options)
        .map(([key, value]) => `${key}=${value}`)
        .join(',')
      args.push('--pack', dials === '' ? packId : `${packId}:${dials}`)
    }
    if (input.acknowledgePackConflict) args.push('--acknowledge-pack-conflict')
    if (input.proposePlan) args.push('--propose-plan')

    // The brief travels on stdin, so a long, newline-heavy design brief never
    // becomes an argv entry.
    const raw = await runControllerWithStdin(
      this.config,
      args,
      Readable.from(Buffer.from(input.brief, 'utf8')),
      this.config.bodyLimitBytes,
    )
    this.watcher.touch()
    return panelEnvelopeSchema.parse(raw).designPanel
  }

  /**
   * Start one participant: ask the controller (which applies every guard and
   * hands back the exact prompt), then run that one account.
   */
  async startParticipant(runId: string, participantId: string): Promise<PanelView> {
    const key = `${runId}:${participantId}`
    // Everything that can refuse this start is decided before the reservation,
    // so a refusal never leaves a slot behind.
    if (this.active.has(key)) {
      throw new PanelBusy(`${participantId} is already running`)
    }
    if (this.deletingRuns.has(runId)) {
      throw new PanelBusy('This run is being deleted; no participant can start.')
    }
    if (this.active.size >= this.config.panelConcurrency) {
      throw new PanelBusy(
        `this console runs at most ${this.config.panelConcurrency} panel participants at once`)
    }
    const account = this.accounts.getConfigured(participantId.replace(/^claude_/, ''))
    if (account === null || account.provider === 'codex') {
      throw new PanelUnavailable('That participant is not a configured Claude account.')
    }
    if (!this.accounts.binaryAvailable(account.provider)) {
      throw new PanelUnavailable('The Claude CLI is not available on this machine.')
    }
    // Take the slot before the first await. This method runs to here without
    // yielding, so two concurrent requests cannot both get past the check above.
    this.active.set(key, null)
    let started
    try {
      started = panelStartSchema.parse(
        await runControllerJson(this.config,
          ['design-panel', 'start', runId, participantId, '--json']),
      )
    } catch (error) {
      this.active.delete(key)
      throw error
    }
    this.watcher.touch()
    void this.execute(runId, started.participantId, account.id,
      String(started.profile ?? account.profile), started.model, started.effort,
      started.prompt, started.mediaPaths)
    return await this.show(runId)
  }

  private async execute(
    runId: string,
    participantId: string,
    accountId: string,
    profile: string,
    model: string,
    effort: string,
    prompt: string,
    mediaPaths: string[],
  ): Promise<void> {
    // The slot is already reserved by startParticipant; this replaces the
    // reservation with the running process, and every exit from here frees it.
    const key = `${runId}:${participantId}`
    let command: RunningPanelCommand
    try {
      const media = await this.accounts.mediaSupport()
      const args = this.claudeArgs(prompt, model, effort, runId, profile)
      if (media.support === 'file' && media.flag !== null) {
        for (const file of mediaPaths) args.push(media.flag, file)
      }
      command = this.runCommand({
        file: this.config.claudeBin,
        args,
        cwd: this.config.sharedRoot,
        env: this.accounts.profileEnv(accountId),
      })
    } catch {
      this.active.delete(key)
      await this.recordFailure(runId, participantId,
        'Claude could not be started for this account.')
      this.watcher.touch()
      return
    }
    this.active.set(key, command)
    const timer = setTimeout(() => {
      try {
        command.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, this.config.panelTimeoutMs)
    try {
      const result = await command.completed
      const answer = readClaudeAnswer(result)
      if (answer.error !== null) {
        process.stderr.write(`fde-gui: design panel ${runId}/${participantId} — claude exited ${result.code}\n`)
        await this.recordFailure(runId, participantId, answer.error)
        return
      }
      await this.recordSuccess(runId, participantId, answer.content)
    } catch {
      process.stderr.write(`fde-gui: design panel ${runId}/${participantId} — claude could not be started\n`)
      await this.recordFailure(runId, participantId,
        'Claude could not be started for this account.')
    } finally {
      clearTimeout(timer)
      this.active.delete(key)
      this.watcher.touch()
    }
  }

  private panelMcp(runId: string, profile: string): { options: string[]; tools: string[] } {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(runId) || !/^[a-z][a-z0-9_-]{0,39}$/.test(profile)) {
      return { options: [], tools: [] }
    }
    const mcpDir = path.join(this.config.runsRoot, runId, 'mcp')
    const config = path.join(mcpDir, `claude-${profile}.mcp.json`)
    const settings = path.join(mcpDir, `claude-${profile}.settings.json`)
    if (!existsSync(config) || !existsSync(settings)) return { options: [], tools: [] }
    try {
      const parsed = JSON.parse(readFileSync(settings, 'utf8')) as {
        permissions?: { allow?: unknown }
      }
      const allow = Array.isArray(parsed.permissions?.allow) ? parsed.permissions.allow : []
      // Keep built-in file, shell and web tools unavailable. The panel receives
      // only the two run-scoped design evidence surfaces the operator requested.
      const tools = allow.filter((item): item is string =>
        typeof item === 'string' && /^mcp__(figma|playwright)(?:__|$)/.test(item))
      if (tools.length === 0) return { options: [], tools: [] }
      return { options: ['--mcp-config', config, '--settings', settings], tools }
    } catch {
      // A malformed or incomplete scope fails closed to the original tool-less
      // panel instead of widening access.
      return { options: [], tools: [] }
    }
  }

  private claudeArgs(
    prompt: string,
    model: string,
    effort: string,
    runId: string,
    profile: string,
  ): string[] {
    // The process remains restricted, plan-only and unable to use built-in
    // repository or shell tools. When mcp-sync generated an enforceable scope,
    // it may inspect Figma and an isolated Playwright browser through those MCP
    // tools only; missing or malformed scope falls back to no tools.
    const mcp = this.panelMcp(runId, profile)
    const args = [
      '--print', prompt,
      '--output-format', 'json',
      '--permission-mode', 'plan',
      '--permission-prompts', 'none',
      '--tools', ...(mcp.tools.length > 0 ? mcp.tools : ['']),
      '--restricted',
      '--strict-mcp-config',
      '--no-chrome',
      '--disable-slash-commands',
      ...mcp.options,
    ]
    if (model !== 'default') args.push('--model', model)
    if (effort !== 'auto') args.push('--effort', effort)
    return args
  }

  private async recordSuccess(runId: string, participantId: string, content: string): Promise<void> {
    const body = Buffer.from(content.slice(0, this.config.panelMaxProposalBytes), 'utf8')
    try {
      await runControllerWithStdin(
        this.config,
        ['design-panel', 'record', runId, participantId, '--status', 'ok', '--stdin', '--json'],
        Readable.from(body),
        this.config.panelMaxProposalBytes,
      )
    } catch {
      await this.recordFailure(runId, participantId,
        'The proposal could not be recorded by the controller.')
    }
  }

  private async recordFailure(runId: string, participantId: string, reason: string): Promise<void> {
    try {
      await runControllerJson(this.config, [
        'design-panel', 'record', runId, participantId,
        '--status', 'failed', '--error', reason, '--json',
      ])
    } catch {
      // The controller refused the record — most often because the participant
      // was stopped while this call was in flight. Its own state is the answer.
    }
  }

  async stopParticipant(runId: string, participantId: string, force = false): Promise<PanelView> {
    if (this.deletingRuns.has(runId)) {
      throw new PanelBusy('This run is being deleted; its panel cannot be changed.')
    }
    // `null` is a slot reserved for a process that has not been spawned yet.
    const command = this.active.get(`${runId}:${participantId}`) ?? null
    if (command !== null) {
      try {
        command.kill(force ? 'SIGKILL' : 'SIGINT')
      } catch {
        /* already gone */
      }
    }
    await runControllerJson(this.config,
      ['design-panel', 'stop', runId, participantId, '--json'])
    this.watcher.touch()
    return await this.show(runId)
  }

  async retryParticipant(runId: string, participantId: string): Promise<PanelView> {
    if (this.deletingRuns.has(runId)) {
      throw new PanelBusy('This run is being deleted; its panel cannot be changed.')
    }
    await runControllerJson(this.config,
      ['design-panel', 'retry', runId, participantId, '--json'])
    this.watcher.touch()
    return await this.show(runId)
  }

  async reconcile(runId: string): Promise<PanelView> {
    const key = `${runId}:reconciliation`
    if (this.deletingRuns.has(runId)) {
      throw new PanelBusy('This run is being deleted; reconciliation cannot start.')
    }
    if (this.active.has(key)) {
      throw new PanelBusy('this panel is already reconciling')
    }
    if (this.active.size >= this.config.panelConcurrency) {
      throw new PanelBusy('this console is already running its limit of panel work')
    }
    // Same reservation as a participant: the limit is checked and taken in one
    // synchronous step, so concurrent reconcile requests cannot both pass it.
    this.active.set(key, null)
    let started
    try {
      started = panelReconcileStartSchema.parse(
        await runControllerJson(this.config, ['design-panel', 'reconcile', runId, '--json']),
      )
    } catch (error) {
      this.active.delete(key)
      throw error
    }
    this.watcher.touch()
    const account = this.accounts.getConfigured(String(started.profile ?? ''))
    if (account === null) {
      this.active.delete(key)
      await this.recordReconciliationFailure(runId,
        'The orchestrator account for this run is not configured on this machine.')
      return await this.show(runId)
    }
    void this.executeReconciliation(runId, account.id,
      String(started.profile ?? account.profile), started.model, started.effort, started.prompt)
    return await this.show(runId)
  }

  private async executeReconciliation(
    runId: string,
    accountId: string,
    profile: string,
    model: string,
    effort: string,
    prompt: string,
  ): Promise<void> {
    const key = `${runId}:reconciliation`
    let command: RunningPanelCommand
    try {
      command = this.runCommand({
        file: this.config.claudeBin,
        args: this.claudeArgs(prompt, model, effort, runId, profile),
        cwd: this.config.sharedRoot,
        env: this.accounts.profileEnv(accountId),
      })
    } catch {
      this.active.delete(key)
      await this.recordReconciliationFailure(runId,
        'Claude could not be started for the orchestrator account.')
      this.watcher.touch()
      return
    }
    this.active.set(key, command)
    const timer = setTimeout(() => {
      try {
        command.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, this.config.panelTimeoutMs)
    try {
      const result = await command.completed
      const answer = readClaudeAnswer(result)
      if (answer.error !== null) {
        process.stderr.write(`fde-gui: design panel ${runId}/reconciliation — claude exited ${result.code}\n`)
        await this.recordReconciliationFailure(runId, answer.error)
        return
      }
      try {
        await runControllerWithStdin(
          this.config,
          ['design-panel', 'record-reconciliation', runId, '--status', 'ok', '--stdin', '--json'],
          Readable.from(Buffer.from(answer.content.slice(0, this.config.panelMaxProposalBytes), 'utf8')),
          this.config.panelMaxProposalBytes,
        )
      } catch (error) {
        // A refused answer is the controller telling us the model did not
        // produce the sections a reconciliation must have. Its words, not ours.
        const detail = error instanceof ControllerError && error.detail !== undefined
          ? error.detail.slice(0, 400)
          : 'The reconciliation answer could not be recorded.'
        await this.recordReconciliationFailure(runId, detail)
      }
    } catch {
      await this.recordReconciliationFailure(runId,
        'Claude could not be started for the orchestrator account.')
    } finally {
      clearTimeout(timer)
      this.active.delete(key)
      this.watcher.touch()
    }
  }

  private async recordReconciliationFailure(runId: string, reason: string): Promise<void> {
    try {
      await runControllerJson(this.config, [
        'design-panel', 'record-reconciliation', runId,
        '--status', 'failed', '--error', reason, '--json',
      ])
    } catch {
      /* the controller's own state is the answer */
    }
  }

  shutdown(): void {
    for (const command of this.active.values()) {
      if (command === null) continue
      try {
        command.kill('SIGHUP')
      } catch {
        /* already gone */
      }
    }
    this.active.clear()
    this.deletingRuns.clear()
  }
}

/**
 * What one account actually said, or a safe reason it did not.
 *
 * Provider output is never copied into a log or an error body: it can carry the
 * brief, the attachments and the proposal. Only these recognised, rewritten
 * sentences reach the operator.
 */
export function readClaudeAnswer(result: { code: number; stdout: string }): {
  content: string
  error: string | null
} {
  let envelope: Record<string, unknown> | null = null
  try {
    envelope = JSON.parse(result.stdout.trim()) as Record<string, unknown>
  } catch {
    /* a non-JSON answer is handled below */
  }
  const text = typeof envelope?.result === 'string' ? envelope.result : result.stdout
  if (result.code !== 0 || envelope?.is_error === true) {
    return { content: '', error: safeProviderFailure(text) }
  }
  const content = (typeof envelope?.result === 'string' ? envelope.result : result.stdout).trim()
  if (content === '') {
    return { content: '', error: 'Claude returned an empty answer for this participant.' }
  }
  return { content, error: null }
}

export function safeProviderFailure(output: string): string {
  if (/not logged in|please run \/login|unauthori[sz]ed|authentication/i.test(output)) {
    return 'This Claude account is not logged in. Sign it in, then retry this participant.'
  }
  if (/usage limit|rate limit|too many requests/i.test(output)) {
    return 'This Claude account has reached a usage or rate limit. Retry it later, or stop it and continue with the others.'
  }
  if (/invalid model|model .*not (?:available|found)|unsupported model/i.test(output)) {
    return 'The selected model is not available for this account. Retry with another model.'
  }
  return 'Claude did not complete this work. Check the account, model and connection, then retry.'
}
