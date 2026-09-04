import { existsSync, statSync, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'

/**
 * Runs change from terminals, not just from this console: `fde resume`, an
 * orchestrator session, a checkpoint recorded by hand. The server watches the
 * run and project roots and keeps a version counter; the UI asks for the counter
 * on a cheap interval and reloads only when it moves.
 *
 * Watching is best-effort. Where the platform cannot do it, `watching` is false
 * and the UI falls back to its own slower polling — the counter still moves
 * after every mutation this console makes.
 */
export class ChangeWatcher {
  version = 0
  watching = false
  lastChangeAt: string | null = null

  private readonly watchers: FSWatcher[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly debounceMs = 400) {}

  start(paths: readonly string[]): void {
    const targets = new Set<string>()
    for (const wanted of paths) {
      const existing = nearestExistingDirectory(wanted)
      if (existing !== null) targets.add(existing)
    }
    for (const target of targets) {
      try {
        const watcher = watch(target, { recursive: true, persistent: false }, () => this.bump())
        watcher.on('error', () => {
          this.watching = false
        })
        this.watchers.push(watcher)
        this.watching = true
      } catch {
        // An unsupported platform is not an error; the UI polls instead.
      }
    }
  }

  /** Called after a mutation, so the console reflects its own writes at once. */
  touch(): void {
    this.version += 1
    this.lastChangeAt = new Date().toISOString()
  }

  private bump(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.touch()
    }, this.debounceMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const watcher of this.watchers) {
      try {
        watcher.close()
      } catch {
        /* closing twice is not a problem worth reporting */
      }
    }
    this.watchers.length = 0
    this.watching = false
  }
}

/**
 * On a fresh install `runs/` and `projects/` do not exist until the first run or
 * project is created, and a watcher on a missing directory is no watcher at all.
 * So watch the nearest directory that does exist — at most a few levels up, and
 * never the filesystem root.
 */
export function nearestExistingDirectory(target: string, maxLevels = 3): string | null {
  let candidate = path.resolve(target)
  for (let level = 0; level <= maxLevels; level += 1) {
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isDirectory()) return candidate
      } catch {
        return null
      }
      return null
    }
    const parent = path.dirname(candidate)
    if (parent === candidate || parent === path.parse(parent).root) return null
    candidate = parent
  }
  return null
}
