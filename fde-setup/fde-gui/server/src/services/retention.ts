import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { GuiConfig } from '../config'
import { runDeletedSchema, runListSchema, statusSchema } from '../schemas/controller'
import { runControllerJson } from './controller'
import type { DesignPanelService } from './design-panel'
import type { AdvisoryLocks } from './locks'
import type { SessionManager } from './sessions'
import type { ChangeWatcher } from './watch'

const DAY_MS = 24 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

export const retentionSettingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  enabled: z.boolean().default(true),
  completedRunDays: z.number().int().min(1).max(3650).default(5),
})

export type RetentionSettings = z.infer<typeof retentionSettingsSchema>

export interface RetentionSweep {
  checkedAt: string
  deletedRunIds: string[]
  skippedRunIds: string[]
  failures: Array<{ runId: string; message: string }>
}

const DEFAULT_SETTINGS: RetentionSettings = {
  schemaVersion: 1,
  enabled: true,
  completedRunDays: 5,
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Retention applies only to controller-authoritative `complete` runs. Deletion
 * still goes through `fde delete`, so the complete run is moved to recoverable
 * trash and its project event is recorded exactly like an operator deletion.
 */
export class RetentionService {
  private timer: NodeJS.Timeout | null = null
  private sweeping: Promise<RetentionSweep> | null = null

  constructor(
    private readonly config: GuiConfig,
    private readonly locks: AdvisoryLocks,
    private readonly sessions: SessionManager,
    private readonly designPanels: DesignPanelService,
    private readonly watcher: ChangeWatcher,
  ) {}

  private get file(): string {
    return path.join(this.config.sharedRoot, 'config', 'retention.json')
  }

  async read(): Promise<RetentionSettings> {
    try {
      return retentionSettingsSchema.parse(JSON.parse(await readFile(this.file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_SETTINGS }
      throw error
    }
  }

  async write(settings: RetentionSettings): Promise<RetentionSettings> {
    const value = retentionSettingsSchema.parse(settings)
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.file)
    this.watcher.touch()
    return value
  }

  start(): void {
    if (this.timer !== null) return
    this.runInBackground()
    this.timer = setInterval(() => this.runInBackground(), SWEEP_INTERVAL_MS)
    this.timer.unref?.()
  }

  private runInBackground(): void {
    void this.sweep().catch((error: unknown) => {
      process.stderr.write(
        `fde-gui: retention sweep failed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    })
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  async sweep(now = Date.now()): Promise<RetentionSweep> {
    if (this.sweeping !== null) return this.sweeping
    this.sweeping = this.runSweep(now).finally(() => { this.sweeping = null })
    return this.sweeping
  }

  private async runSweep(now: number): Promise<RetentionSweep> {
    const settings = await this.read()
    const result: RetentionSweep = {
      checkedAt: new Date(now).toISOString(),
      deletedRunIds: [],
      skippedRunIds: [],
      failures: [],
    }
    if (!settings.enabled) return result

    const cutoff = now - settings.completedRunDays * DAY_MS
    const listing = runListSchema.parse(await runControllerJson(this.config, ['list', '--json']))
    const candidates = listing.runs.filter((run) => {
      const updatedAt = timestamp(run.updatedAt)
      return run.state === 'complete' && updatedAt !== null && updatedAt <= cutoff
    })

    for (const candidate of candidates) {
      const releaseRun = this.locks.tryAcquire(`run:${candidate.runId}`)
      const releaseSession = this.locks.tryAcquire(`session:${candidate.runId}`)
      if (releaseRun === null || releaseSession === null) {
        releaseRun?.()
        releaseSession?.()
        result.skippedRunIds.push(candidate.runId)
        continue
      }
      const releasePanel = this.designPanels.beginRunDeletion(candidate.runId)
      if (releasePanel === null || this.sessions.isRunning(candidate.runId)) {
        releasePanel?.()
        releaseSession()
        releaseRun()
        result.skippedRunIds.push(candidate.runId)
        continue
      }
      let releaseProject = (): void => undefined
      try {
        // Re-read under the run lock. A stale list result must never delete a
        // run that is no longer complete or whose retention clock moved.
        const status = statusSchema.parse(await runControllerJson(
          this.config, ['status', candidate.runId, '--json', '--events-limit', '1'],
        ))
        const statusUpdatedAt = typeof status.manifest.updatedAt === 'string'
          ? status.manifest.updatedAt
          : ''
        const confirmedUpdatedAt = timestamp(statusUpdatedAt)
        if (status.state !== 'complete' || confirmedUpdatedAt === null || confirmedUpdatedAt > cutoff) {
          result.skippedRunIds.push(candidate.runId)
          continue
        }
        if (status.projectId) {
          const acquired = this.locks.tryAcquire(`project:${status.projectId}`)
          if (acquired === null) {
            result.skippedRunIds.push(candidate.runId)
            continue
          }
          releaseProject = acquired
        }
        runDeletedSchema.parse(await runControllerJson(this.config, [
          'delete', candidate.runId, '--confirm', candidate.runId, '--json',
        ]))
        if (this.sessions.get(candidate.runId) !== null) this.sessions.delete(candidate.runId)
        result.deletedRunIds.push(candidate.runId)
        this.watcher.touch()
      } catch (error) {
        result.failures.push({
          runId: candidate.runId,
          message: error instanceof Error ? error.message : String(error),
        })
      } finally {
        releaseProject()
        releasePanel()
        releaseSession()
        releaseRun()
      }
    }
    return result
  }
}
