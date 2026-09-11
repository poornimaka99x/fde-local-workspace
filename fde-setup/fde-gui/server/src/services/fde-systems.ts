import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { GuiConfig } from '../config'
import { runCreatedSchema } from '../schemas/controller'
import type { AccountService } from './accounts'
import { runController, runControllerJson } from './controller'

export const FDE_SYSTEM_TYPE = 'forward-deployed-engineer' as const
export const FDE_EXECUTOR_TYPE = 'forward-deployed-engineer' as const
export const DEFAULT_FDE_CONFIGURATION_ID = 'default-forward-deployed-engineer'

export const FDE_STAGE_DEFINITIONS = [
  { id: 'business-intent', label: 'Business Intent Analysis', controllerStages: ['intake'] },
  { id: 'solution-requirements', label: 'Solution Requirements', controllerStages: ['research'] },
  { id: 'technical-architecture', label: 'Technical Requirements and Architecture', controllerStages: ['solutioning'] },
  { id: 'development-planning', label: 'Development Planning', controllerStages: ['planning'] },
  { id: 'vertical-slice', label: 'Vertical-Slice Implementation', controllerStages: ['implementation'] },
  { id: 'quality-review', label: 'Quality Assurance', controllerStages: ['review', 'verification'] },
  { id: 'documentation', label: 'Implementation Documentation', controllerStages: ['presentation', 'publication'] },
  { id: 'scm-build-deploy', label: 'Source Control, Build and Deployment', controllerStages: ['deployment'] },
  { id: 'operations', label: 'Operations Engineering', controllerStages: ['observability'] },
] as const

export type CapabilityState = 'inherit' | 'enabled' | 'disabled'

export interface FdeStageConfiguration {
  id: string
  label: string
  enabled: boolean
  primaryAccount: string | null
  reviewerAccount: string | null
  approvalRequired: true
  capabilityOverrides: Record<string, CapabilityState>
}

export interface FdeSystemConfiguration {
  schemaVersion: 1
  id: string
  version: number
  systemType: typeof FDE_SYSTEM_TYPE
  executorType: typeof FDE_EXECUTOR_TYPE
  name: string
  description: string
  enabled: boolean
  projectId: string | null
  repository: string | null
  workspace: string | null
  artifactRoot: string
  orchestrator: string
  reviewer: string | null
  routing: 'auto' | 'manual'
  strategy: 'balanced' | 'quality_first' | 'cost_first'
  model: string
  effort: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  stages: FdeStageConfiguration[]
  governance: {
    approvalAfterEveryStage: true
    approvalBeforeCodeChanges: true
    approvalBeforeDeployment: true
    approvalBeforeProductionMutation: true
    stopOnAmbiguity: true
  }
  createdAt: string
  updatedAt: string
}

export interface FdeRunRegistration {
  schemaVersion: 1
  runId: string
  systemType: typeof FDE_SYSTEM_TYPE
  executorType: typeof FDE_EXECUTOR_TYPE
  configurationId: string
  configurationVersion: number
  configurationSnapshot: FdeSystemConfiguration
  businessIntent: string
  createdAt: string
}

export const FDE_SYSTEM_DEFINITION = {
  id: FDE_SYSTEM_TYPE,
  name: 'Forward Deployed Engineer',
  shortName: 'FDE',
  description: 'Human-governed product delivery from business intent through operations.',
  executorType: FDE_EXECUTOR_TYPE,
  lifecycle: FDE_STAGE_DEFINITIONS.map((stage) => ({ ...stage })),
} as const

function now(): string { return new Date().toISOString() }

function configurationRoot(config: GuiConfig): string {
  return path.join(config.sharedRoot, 'config', 'system-configurations', FDE_SYSTEM_TYPE)
}

function registrationRoot(config: GuiConfig): string {
  return path.join(config.sharedRoot, 'config', 'system-runs', FDE_SYSTEM_TYPE)
}

function safeId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{2,79}$/.test(value)
}

function defaultStages(): FdeStageConfiguration[] {
  return FDE_STAGE_DEFINITIONS.map((stage) => ({
    id: stage.id,
    label: stage.label,
    enabled: true,
    primaryAccount: null,
    reviewerAccount: null,
    approvalRequired: true,
    capabilityOverrides: {},
  }))
}

export function defaultFdeConfiguration(): FdeSystemConfiguration {
  // Built-in data must not appear to change on every read. The timestamp is
  // the template revision date; the first operator save gets its real time.
  const timestamp = '2026-09-11T00:00:00.000Z'
  return {
    schemaVersion: 1,
    id: DEFAULT_FDE_CONFIGURATION_ID,
    version: 1,
    systemType: FDE_SYSTEM_TYPE,
    executorType: FDE_EXECUTOR_TYPE,
    name: 'Default Forward Deployed Engineer',
    description: 'The complete nine-stage, independently reviewed FDE lifecycle.',
    enabled: true,
    projectId: null,
    repository: null,
    workspace: null,
    artifactRoot: 'docs/fde',
    orchestrator: 'work',
    reviewer: null,
    routing: 'auto',
    strategy: 'balanced',
    model: 'default',
    effort: 'auto',
    stages: defaultStages(),
    governance: {
      approvalAfterEveryStage: true,
      approvalBeforeCodeChanges: true,
      approvalBeforeDeployment: true,
      approvalBeforeProductionMutation: true,
      stopOnAmbiguity: true,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

async function atomicJson(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}

function normalizeConfiguration(raw: FdeSystemConfiguration): FdeSystemConfiguration {
  const known = new Map(raw.stages.map((stage) => [stage.id, stage]))
  return {
    ...raw,
    schemaVersion: 1,
    systemType: FDE_SYSTEM_TYPE,
    executorType: FDE_EXECUTOR_TYPE,
    stages: defaultStages().map((fallback) => {
      const saved = known.get(fallback.id)
      return saved === undefined ? fallback : {
        ...fallback,
        ...saved,
        id: fallback.id,
        label: fallback.label,
        approvalRequired: true,
        capabilityOverrides: saved.capabilityOverrides ?? {},
      }
    }),
    governance: {
      approvalAfterEveryStage: true,
      approvalBeforeCodeChanges: true,
      approvalBeforeDeployment: true,
      approvalBeforeProductionMutation: true,
      stopOnAmbiguity: true,
    },
  }
}

export function validateFdeConfiguration(configuration: FdeSystemConfiguration): string[] {
  const errors: string[] = []
  if (!safeId(configuration.id)) errors.push('Configuration id is invalid.')
  if (configuration.name.trim().length < 3) errors.push('Configuration name is required.')
  if (!configuration.enabled) errors.push('Configuration is disabled.')
  if (!configuration.stages.some((stage) => stage.enabled)) errors.push('At least one lifecycle stage must be enabled.')
  if (configuration.orchestrator.trim() === '') errors.push('An orchestrator account is required.')
  return errors
}

export async function listFdeConfigurations(config: GuiConfig): Promise<FdeSystemConfiguration[]> {
  const root = configurationRoot(config)
  const records = new Map<string, FdeSystemConfiguration>()
  records.set(DEFAULT_FDE_CONFIGURATION_ID, defaultFdeConfiguration())
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return [...records.values()] }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await readFile(path.join(root, entry.name), 'utf8')) as FdeSystemConfiguration
      if (parsed.schemaVersion === 1 && safeId(parsed.id)) records.set(parsed.id, normalizeConfiguration(parsed))
    } catch { /* A broken profile cannot replace the safe built-in default. */ }
  }
  return [...records.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function getFdeConfiguration(config: GuiConfig, id: string): Promise<FdeSystemConfiguration | null> {
  return (await listFdeConfigurations(config)).find((record) => record.id === id) ?? null
}

export async function saveFdeConfiguration(
  config: GuiConfig,
  input: FdeSystemConfiguration,
): Promise<FdeSystemConfiguration> {
  if (!safeId(input.id)) throw new Error('Configuration id is invalid.')
  const current = await getFdeConfiguration(config, input.id)
  const timestamp = now()
  const record = normalizeConfiguration({
    ...input,
    version: (current?.version ?? 0) + 1,
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp,
  })
  const errors = validateFdeConfiguration({ ...record, enabled: true })
    .filter((message) => message !== 'Configuration is disabled.')
  if (errors.length > 0) throw new Error(errors.join(' '))
  await atomicJson(path.join(configurationRoot(config), `${record.id}.json`), record)
  return record
}

export async function createFdeConfiguration(
  config: GuiConfig,
  name: string,
): Promise<FdeSystemConfiguration> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56) || 'fde'
  const record = defaultFdeConfiguration()
  record.id = `${slug}-${randomUUID().slice(0, 8)}`
  record.name = name.trim()
  record.createdAt = now()
  record.updatedAt = record.createdAt
  return await saveFdeConfiguration(config, { ...record, version: 0 })
}

export async function deleteFdeConfiguration(config: GuiConfig, id: string): Promise<void> {
  if (!safeId(id) || id === DEFAULT_FDE_CONFIGURATION_ID) {
    throw new Error('The built-in default configuration cannot be deleted.')
  }
  await rm(path.join(configurationRoot(config), `${id}.json`), { force: true })
}

export async function registerFdeRun(config: GuiConfig, registration: FdeRunRegistration): Promise<void> {
  await atomicJson(path.join(registrationRoot(config), `${registration.runId}.json`), registration)
}

export async function listFdeRunRegistrations(config: GuiConfig): Promise<FdeRunRegistration[]> {
  const root = registrationRoot(config)
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return [] }
  const records: FdeRunRegistration[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    try {
      const record = JSON.parse(await readFile(path.join(root, entry.name), 'utf8')) as FdeRunRegistration
      if (record.schemaVersion === 1 && record.systemType === FDE_SYSTEM_TYPE) records.push(record)
    } catch { /* Ignore one damaged index entry; the controller run remains intact. */ }
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export interface StartFdeRunInput {
  configuration: FdeSystemConfiguration
  businessIntent: string
  projectId?: string
  orchestrator?: string
}

export class ForwardDeployedEngineerExecutor {
  readonly type = FDE_EXECUTOR_TYPE

  constructor(
    private readonly config: GuiConfig,
    private readonly accounts: AccountService,
  ) {}

  validateConfiguration(configuration: FdeSystemConfiguration): string[] {
    return validateFdeConfiguration(configuration)
  }

  async createRun(input: StartFdeRunInput): Promise<{
    registration: FdeRunRegistration
    run: ReturnType<typeof runCreatedSchema.parse>['run']
    nextAction: string | null | undefined
  }> {
    const errors = this.validateConfiguration(input.configuration)
    if (errors.length > 0) throw new Error(errors.join(' '))
    const accountId = input.orchestrator?.trim() || input.configuration.orchestrator
    const account = this.accounts.getConfigured(accountId)
    if (account === null || account.identityId === null || !account.capabilities.includes('orchestration')) {
      throw new Error('Choose a configured account that is allowed to orchestrate runs.')
    }
    if (
      input.configuration.routing === 'manual'
      && account.provider !== 'codex'
      && !this.accounts.validateSelection(
        accountId,
        input.configuration.model,
        input.configuration.effort,
      )
    ) {
      throw new Error('The configured model and effort are not available for the selected account.')
    }
    if (account.provider !== 'codex') {
      const auth = await this.accounts.status(accountId)
      if (auth.state === 'login_required') {
        throw new Error('Sign in to the selected account before starting the run.')
      }
      if (auth.state === 'unavailable') {
        throw new Error('The selected orchestrator account is unavailable.')
      }
    }

    const enabledStages = input.configuration.stages
      .filter((stage) => stage.enabled)
      .flatMap((stage) => FDE_STAGE_DEFINITIONS.find((definition) => definition.id === stage.id)?.controllerStages ?? [])
    const allStages = FDE_STAGE_DEFINITIONS.flatMap((stage) => [...stage.controllerStages])
    const args = ['start', '--json', '--orchestrator', account.identityId]
    if (input.configuration.routing === 'auto') {
      args.push('--routing', 'auto', '--strategy', input.configuration.strategy)
    } else if (account.provider !== 'codex') {
      args.push('--model', input.configuration.model, '--effort', input.configuration.effort)
    }
    const projectId = input.projectId ?? input.configuration.projectId
    if (projectId) args.push('--project', projectId)
    if (enabledStages.length === allStages.length && enabledStages.every((stage, index) => stage === allStages[index])) {
      args.push('--shape', 'full')
    }
    args.push('--', input.businessIntent.trim())
    const created = runCreatedSchema.parse(await runControllerJson(this.config, args))
    if (!args.includes('--shape')) {
      await runController(this.config, ['plan', created.run.runId, '--stages', enabledStages.join(',')])
    }
    const registration: FdeRunRegistration = {
      schemaVersion: 1,
      runId: created.run.runId,
      systemType: FDE_SYSTEM_TYPE,
      executorType: this.type,
      configurationId: input.configuration.id,
      configurationVersion: input.configuration.version,
      configurationSnapshot: input.configuration,
      businessIntent: input.businessIntent.trim(),
      createdAt: now(),
    }
    await registerFdeRun(this.config, registration)
    return { registration, run: created.run, nextAction: created.nextAction }
  }
}

export class SystemExecutorRegistry {
  private readonly executors = new Map<string, ForwardDeployedEngineerExecutor>()

  register(executor: ForwardDeployedEngineerExecutor): void {
    this.executors.set(executor.type, executor)
  }

  get(type: string): ForwardDeployedEngineerExecutor | null {
    return this.executors.get(type) ?? null
  }
}
