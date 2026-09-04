import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildApp } from '../../server/src/app'
import { loadConfig, type GuiConfig } from '../../server/src/config'
import { AdvisoryLocks } from '../../server/src/services/locks'
import { ChangeWatcher } from '../../server/src/services/watch'

/**
 * Every server test runs against a throwaway FDE root and a stub controller.
 * Nothing here reads or writes the operator's real ~/.claude-shared, profiles,
 * credentials or runs, and no real `fde`, `claude` or `codex` is ever executed.
 */
const STUB = `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const shared = process.env.CLAUDE_SHARED
const dir = path.join(shared, 'stub')
const args = process.argv.slice(2)
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(args) + '\\n')

const firstFlag = args.findIndex((a) => a.startsWith('--'))
const positional = firstFlag === -1 ? args : args.slice(0, firstFlag)
const flagValue = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1]
}
const key = positional.join('-').replace(/[^A-Za-z0-9._-]/g, '_')

if (args.includes('--stdin')) {
  const received = fs.readFileSync(0)
  fs.writeFileSync(path.join(dir, 'stdin-' + key + '.bin'), received)
}

const failure = path.join(dir, 'fail-' + key)
if (fs.existsSync(failure)) {
  const [code, ...rest] = fs.readFileSync(failure, 'utf8').trim().split(':')
  process.stderr.write(rest.join(':') + '\\n')
  process.exit(Number(code))
}

const raw = path.join(dir, 'raw-' + key)
if (fs.existsSync(raw)) {
  process.stdout.write(fs.readFileSync(raw, 'utf8'))
  process.exit(0)
}

const fixture = path.join(dir, key + '.json')
if (!fs.existsSync(fixture)) {
  process.stderr.write('fde: no such run: ' + positional.join(' ') + '\\n')
  process.exit(4)
}
const payload = JSON.parse(fs.readFileSync(fixture, 'utf8'))
if (payload && payload.events) {
  const limit = Number(flagValue('--events-limit') || payload.events.limit || 50)
  const cursorRaw = flagValue('--events-cursor')
  const total = payload.events.total
  const offset = cursorRaw === null ? Math.max(0, total - limit) : Number(cursorRaw)
  payload.events.limit = limit
  payload.events.offset = offset
  payload.events.returned = Math.min(limit, Math.max(0, total - offset))
  payload.events.nextCursor = offset + payload.events.returned < total ? offset + payload.events.returned : null
}
process.stdout.write(JSON.stringify(payload))
`

export interface Harness {
  config: GuiConfig
  app: ReturnType<typeof buildApp>
  locks: AdvisoryLocks
  watcher: ChangeWatcher
  stdinFor: (name: string) => Buffer | null
  root: string
  runsRoot: string
  stubDir: string
  token: string
  fixture: (name: string, payload: unknown) => void
  rawFixture: (name: string, body: string) => void
  failure: (name: string, code: number, message: string) => void
  calls: () => string[][]
  destroy: () => Promise<void>
}

export async function makeHarness(
  options: { withController?: boolean; maxUploadBytes?: number } = {},
): Promise<Harness> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fde-gui-test-'))
  const home = path.join(root, 'home')
  const shared = path.join(home, '.claude-shared')
  const stubDir = path.join(shared, 'stub')
  const runsRoot = path.join(shared, 'runs')
  for (const dir of [path.join(shared, 'bin'), stubDir, runsRoot, path.join(shared, 'projects'), path.join(home, '.claude-profiles', 'work')]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(path.join(stubDir, 'calls.log'), '')

  const controllerPath = path.join(shared, 'bin', 'fde')
  if (options.withController !== false) {
    writeFileSync(controllerPath, STUB)
    chmodSync(controllerPath, 0o755)
  }

  const token = 'test-token-not-a-real-one'
  const config = loadConfig({
    HOME: home,
    CLAUDE_SHARED: shared,
    FDE_RUNS_DIR: runsRoot,
    FDE_PROJECTS_DIR: path.join(shared, 'projects'),
    CLAUDE_PROFILES_DIR: path.join(home, '.claude-profiles'),
    FDE_GUI_TOKEN: token,
    FDE_GUI_PORT: '7317',
    ...(options.maxUploadBytes === undefined
      ? {}
      : { FDE_GUI_MAX_UPLOAD_BYTES: String(options.maxUploadBytes) }),
    PATH: process.env.PATH,
  } as NodeJS.ProcessEnv)

  const locks = new AdvisoryLocks()
  const watcher = new ChangeWatcher(10)
  const app = buildApp(config, { locks, watcher })
  await app.ready()

  return {
    config,
    app,
    locks,
    watcher,
    stdinFor: (name) => {
      const file = path.join(stubDir, `stdin-${name}.bin`)
      return existsSync(file) ? readFileSync(file) : null
    },
    root,
    runsRoot,
    stubDir,
    token,
    fixture: (name, payload) => writeFileSync(path.join(stubDir, `${name}.json`), JSON.stringify(payload)),
    rawFixture: (name, body) => writeFileSync(path.join(stubDir, `raw-${name}`), body),
    failure: (name, code, message) => writeFileSync(path.join(stubDir, `fail-${name}`), `${code}:${message}`),
    calls: () =>
      readFileSync(path.join(stubDir, 'calls.log'), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as string[]),
    destroy: async () => {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export function authed(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'sec-fetch-site': 'same-origin' }
}

/** A run directory with the awkward cases a real one eventually grows. */
export function seedRunDirectory(runsRoot: string, runId: string): string {
  const runDir = path.join(runsRoot, runId)
  mkdirSync(path.join(runDir, 'artifacts', 'research'), { recursive: true })
  mkdirSync(path.join(runDir, 'inputs', 'files'), { recursive: true })
  mkdirSync(path.join(runDir, 'mcp'), { recursive: true })
  writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ runId, state: 'research' }))
  writeFileSync(path.join(runDir, 'requirement.md'), '# Requirement\n\nDo the thing.\n')
  writeFileSync(path.join(runDir, 'approvals.jsonl'), '{"type":"codex-approval"}\n')
  writeFileSync(path.join(runDir, 'orchestrator-session-id'), 'abc-123\n')
  writeFileSync(path.join(runDir, 'mcp', 'claude-work.mcp.json'), '{"headers":{"Authorization":"Bearer secret"}}')
  writeFileSync(path.join(runDir, 'artifacts', 'research', 'research-brief.md'), '# Brief\n\n- one\n- two\n')
  writeFileSync(path.join(runDir, 'artifacts', 'research', 'notes.html'), '<script>alert(1)</script>')
  writeFileSync(path.join(runDir, 'inputs', 'files', 'requirements-ab12.txt'), 'attached bytes')
  writeFileSync(path.join(runDir, 'secret-outside-target.txt'), 'inside the run')
  symlinkSync('/etc/passwd', path.join(runDir, 'artifacts', 'escape.txt'))
  symlinkSync(path.dirname(runsRoot), path.join(runDir, 'artifacts', 'up'))
  return runDir
}
