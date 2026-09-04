import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChangeWatcher, nearestExistingDirectory } from '../../server/src/services/watch'
import { AdvisoryLocks } from '../../server/src/services/locks'

describe('advisory locks', () => {
  it('lets one holder in at a time and releases exactly once', () => {
    const locks = new AdvisoryLocks()
    const first = locks.tryAcquire('run:a')
    expect(first).not.toBeNull()
    expect(locks.tryAcquire('run:a')).toBeNull()
    expect(locks.tryAcquire('run:b')).not.toBeNull()
    first?.()
    first?.()
    expect(locks.isHeld('run:a')).toBe(false)
    expect(locks.tryAcquire('run:a')).not.toBeNull()
  })
})

describe('change watcher', () => {
  const roots: string[] = []
  const watchers: ChangeWatcher[] = []

  afterEach(() => {
    for (const watcher of watchers) watcher.stop()
    watchers.length = 0
    for (const root of roots) rmSync(root, { recursive: true, force: true })
    roots.length = 0
  })

  const tempRoot = (): string => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'fde-watch-'))
    roots.push(root)
    return root
  }

  it('watches the nearest directory that exists, so a fresh install is covered', () => {
    const root = tempRoot()
    const shared = path.join(root, 'shared')
    mkdirSync(shared)
    // runs/ does not exist yet — as on a machine that has never made a run.
    expect(nearestExistingDirectory(path.join(shared, 'runs'))).toBe(shared)
    expect(nearestExistingDirectory(path.join(root, 'a', 'b', 'c', 'd', 'e'))).toBeNull()
  })

  it('notices a change that a terminal made, once, after the debounce', async () => {
    const root = tempRoot()
    const runs = path.join(root, 'runs')
    mkdirSync(runs)
    const watcher = new ChangeWatcher(20)
    watchers.push(watcher)
    watcher.start([runs])
    expect(watcher.watching).toBe(true)

    // macOS FSEvents may report the watcher as created just before its stream
    // is ready when the full suite is starting many processes in parallel.
    await new Promise((resolve) => setTimeout(resolve, 100))

    writeFileSync(path.join(runs, 'manifest.json'), '{}')
    writeFileSync(path.join(runs, 'events.jsonl'), '{}')

    const deadline = Date.now() + 3000
    while (watcher.version === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(watcher.version).toBeGreaterThan(0)
    expect(watcher.version).toBeLessThan(3)
    expect(watcher.lastChangeAt).not.toBeNull()
  })

  it('still moves its counter for the console\u2019s own changes when watching is off', () => {
    const watcher = new ChangeWatcher(20)
    watchers.push(watcher)
    watcher.start([path.join(os.tmpdir(), 'definitely', 'not', 'here', 'at', 'all')])
    expect(watcher.watching).toBe(false)
    watcher.touch()
    expect(watcher.version).toBe(1)
  })
})
