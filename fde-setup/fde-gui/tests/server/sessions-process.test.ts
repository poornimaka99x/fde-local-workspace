import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SessionManager,
  type SpawnTerminal,
  type TerminalProcess,
} from '../../server/src/services/sessions'

/**
 * A real process, driven through the same manager the console uses.
 *
 * node-pty could not be installed in this environment, so this adapter uses
 * pipes instead of a pty. It is a test adapter and nothing else: it exists to
 * prove the manager starts, streams, writes to, signals and reaps a genuine OS
 * process. The pty layer itself is the one part these tests cannot cover.
 */
const pipeSpawn: SpawnTerminal = (options): TerminalProcess => {
  const child = spawn(options.file, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const data: ((chunk: string) => void)[] = []
  const exits: ((event: { exitCode: number }) => void)[] = []
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => data.forEach((listener) => listener(chunk)))
  child.stderr.on('data', (chunk: string) => data.forEach((listener) => listener(chunk)))
  child.on('close', (code, signal) =>
    exits.forEach((listener) => listener({ exitCode: code ?? (signal === null ? 0 : 130) })),
  )
  return {
    get pid() {
      return child.pid ?? -1
    },
    onData: (listener) => data.push(listener),
    onExit: (listener) => exits.push(listener),
    write: (payload) => child.stdin.write(payload),
    resize: () => undefined,
    kill: (signal) => child.kill((signal ?? 'SIGTERM') as NodeJS.Signals),
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (!predicate()) throw new Error('timed out waiting for the process')
}

describe('the manager against a real process', () => {
  const managers: SessionManager[] = []
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'fde-launcher-'))
  })
  afterEach(() => {
    for (const manager of managers) manager.shutdown()
    managers.length = 0
    rmSync(root, { recursive: true, force: true })
  })

  const manager = (): SessionManager => {
    const made = new SessionManager(pipeSpawn)
    managers.push(made)
    return made
  }

  /** A stand-in launcher: same shape as `fde-start --resume <run-id>`. */
  const launcher = (name: string, script: string): string => {
    const file = path.join(root, name)
    writeFileSync(file, `#!/bin/sh\n${script}\n`)
    chmodSync(file, 0o755)
    return file
  }

  const env = { PATH: process.env.PATH ?? '/bin:/usr/bin' }

  it('streams what the process prints, and what it prints after being typed to', async () => {
    const sessions = manager()
    const startBin = launcher(
      'echoing',
      [
        'echo "resuming $2"',
        'while IFS= read -r line; do',
        '  case "$line" in',
        '    exit:*) exit "${line#exit:}" ;;',
        '    *) echo "got:$line" ;;',
        '  esac',
        'done',
      ].join('\n'),
    )
    const chunks: string[] = []
    const view = sessions.start({ runId: 'run-real-1', startBin, cwd: root, env })
    expect(view.pid).toBeGreaterThan(0)
    expect(view.command).toEqual([startBin, '--resume', 'run-real-1'])
    sessions.attach('run-real-1', (chunk) => chunks.push(chunk), () => undefined)

    await waitFor(() => chunks.join('').includes('resuming run-real-1'))

    sessions.write('run-real-1', 'APPROVE PLAN\n')
    await waitFor(() => chunks.join('').includes('got:APPROVE PLAN'))

    sessions.write('run-real-1', 'exit:7\n')
    await waitFor(() => sessions.get('run-real-1')?.status === 'exited')
    expect(sessions.get('run-real-1')?.exitCode).toBe(7)
  })

  it('interrupts a running process, and force-stops one that ignores the interrupt', async () => {
    const sessions = manager()
    const startBin = launcher(
      'stubborn',
      ["trap '' INT", 'echo started', 'while true; do sleep 0.2; done'].join('\n'),
    )
    const chunks: string[] = []
    sessions.start({ runId: 'run-real-2', startBin, cwd: root, env })
    sessions.attach('run-real-2', (chunk) => chunks.push(chunk), () => undefined)
    await waitFor(() => chunks.join('').includes('started'))

    sessions.stop('run-real-2')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(sessions.get('run-real-2')?.status).toBe('running')
    expect(sessions.get('run-real-2')?.stopRequestedAt).not.toBeNull()

    sessions.stop('run-real-2', { force: true })
    await waitFor(() => sessions.get('run-real-2')?.status === 'exited')
  })

  it('caps what it keeps in memory', async () => {
    const sessions = manager()
    const startBin = launcher(
      'flooding',
      ["awk 'BEGIN{for(i=0;i<40000;i++) print \"a line of output\"}'", 'exit 0'].join('\n'),
    )
    sessions.start({ runId: 'run-real-3', startBin, cwd: root, env })
    await waitFor(() => sessions.get('run-real-3')?.status === 'exited', 10000)

    const attached = sessions.attach('run-real-3', () => undefined, () => undefined)
    expect(attached.backlog.length).toBeLessThanOrEqual(256 * 1024)
    expect(attached.backlog.length).toBeGreaterThan(200 * 1024)
    expect(attached.backlog).toContain('a line of output')
  }, 15000)
})
