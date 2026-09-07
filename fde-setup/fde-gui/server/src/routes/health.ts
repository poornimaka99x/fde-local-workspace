import { readdirSync } from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { GuiConfig } from '../config'
import { isExecutable } from '../config'
import type { Services } from '../services/types'
import { ControllerError, runControllerJson } from '../services/controller'

/**
 * What this console is pointed at, and which pieces are present. Nothing here
 * reads a credential, calls a network service or runs `fde doctor`: those are
 * user-triggered checks and belong to a later phase.
 */
interface ContractCheck {
  ok: boolean
  schemaVersion: number | null
  contracts: string[]
  problem: string | null
  detail: string | null
}

export function registerHealthRoutes(
  app: FastifyInstance,
  config: GuiConfig,
  services: Services,
): void {
  const startedAt = new Date().toISOString()

  // Asking the controller what it speaks, rather than finding out from a failed
  // request later. Cached briefly: health is polled, and this spawns a process.
  let cached: { at: number; result: ContractCheck } | null = null
  const checkContracts = async (): Promise<ContractCheck> => {
    if (cached !== null && Date.now() - cached.at < 15_000) return cached.result
    let result: ContractCheck
    try {
      const raw = (await runControllerJson(config, ['version', '--json'])) as {
        schemaVersion?: unknown
        contracts?: unknown
      }
      const schemaVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : null
      result = {
        ok: schemaVersion === 1,
        schemaVersion,
        contracts: Array.isArray(raw.contracts) ? raw.contracts.map(String) : [],
        problem: schemaVersion === 1 ? null : 'controller-schema-mismatch',
        detail:
          schemaVersion === 1
            ? null
            : `The controller reports schema ${String(schemaVersion)}; this console understands 1.`,
      }
    } catch (error) {
      const known = error instanceof ControllerError
      result = {
        ok: false,
        schemaVersion: null,
        contracts: [],
        problem: known ? error.code : 'controller-unavailable',
        detail: known ? (error.detail ?? error.message) : 'The controller could not be run.',
      }
    }
    cached = { at: Date.now(), result }
    return result
  }

  app.get('/api/health', async () => {
    const contracts = await checkContracts()
    let profiles: string[] = []
    try {
      profiles = readdirSync(config.profilesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    } catch {
      profiles = []
    }
    return {
      status: 'ok',
      version: config.version,
      apiVersion: config.apiVersion,
      startedAt,
      mode: 'local workspace',
      roots: {
        shared: config.sharedRoot,
        runs: config.runsRoot,
        projects: config.projectsRoot,
        chats: config.chatsRoot,
        profiles: config.profilesRoot,
      },
      controller: contracts,
      binaries: {
        fde: { path: config.fdeBin, present: isExecutable(config.fdeBin) },
        fdeStart: { path: config.fdeStartBin, present: isExecutable(config.fdeStartBin) },
        claude: { path: config.claudeBin, present: isExecutable(config.claudeBin) },
        codex: { path: config.codexBin, present: isExecutable(config.codexBin) },
      },
      // Names only. No credential file is opened, and none is reported.
      claudeProfiles: profiles.map((name) => ({
        name,
        path: path.join(config.profilesRoot, name),
      })),
    }
  })

  /**
   * A counter, not a payload. Runs change from terminals too, so the console
   * asks for this on a short interval and reloads only when it moves. When the
   * platform cannot watch, `watching` is false and the UI keeps to its own
   * slower polling.
   */
  app.get('/api/state-version', async () => ({
    version: services.watcher.version,
    watching: services.watcher.watching,
    lastChangeAt: services.watcher.lastChangeAt,
  }))
}
