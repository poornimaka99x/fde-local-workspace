import { readdirSync } from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { GuiConfig } from '../config'
import { isExecutable } from '../config'
import type { Services } from '../services/types'

/**
 * What this console is pointed at, and which pieces are present. Nothing here
 * reads a credential, calls a network service or runs `fde doctor`: those are
 * user-triggered checks and belong to a later phase.
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  config: GuiConfig,
  services: Services,
): void {
  const startedAt = new Date().toISOString()

  app.get('/api/health', async () => {
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
      mode: 'read-only',
      roots: {
        shared: config.sharedRoot,
        runs: config.runsRoot,
        projects: config.projectsRoot,
        profiles: config.profilesRoot,
      },
      binaries: {
        fde: { path: config.fdeBin, present: isExecutable(config.fdeBin) },
        fdeStart: { path: config.fdeStartBin, present: isExecutable(config.fdeStartBin) },
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
