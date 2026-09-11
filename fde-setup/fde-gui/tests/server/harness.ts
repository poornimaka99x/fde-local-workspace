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
import { AccountService } from '../../server/src/services/accounts'
import { ChatService } from '../../server/src/services/chats'
import { DesignPanelService, type PanelCommandRunner } from '../../server/src/services/design-panel'
import { AdvisoryLocks } from '../../server/src/services/locks'
import { SessionManager, type SpawnTerminal } from '../../server/src/services/sessions'
import { ChangeWatcher } from '../../server/src/services/watch'

/**
 * Every server test runs against a throwaway FLOW root and a stub controller.
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

// 'accounts set-secret' takes its value on stdin and names no flag for it:
// a secret must not appear in argv, so there is nothing there to key off.
const readsStdin = args.includes('--stdin') || args.includes('--brief-stdin')
  || args.includes('--requirement-stdin')
  || (args[0] === 'accounts' && args[1] === 'set-secret')
  || (args[0] === 'connections' && args[1] === 'set-secret')
  || (args[0] === 'connections' && args[1] === 'context')
  || (args[0] === 'mcp' && args[1] === 'set-secret')
if (readsStdin) {
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

const CLAUDE_STUB = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'test-subscription' }))
  process.exit(0)
}
if (args.includes('--print')) {
  const prompt = args[args.indexOf('--print') + 1] || ''
  const sessionFlag = args.includes('--session-id') ? '--session-id' : '--resume'
  const session = args[args.indexOf(sessionFlag) + 1]
  process.stdout.write(JSON.stringify({ result: 'Claude reply: ' + prompt, session_id: session }))
  process.exit(0)
}
process.exit(0)
`

const CODEX_STUB = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'login' && args[1] === 'status') {
  process.stderr.write('Logged in using ChatGPT\\n')
  process.exit(0)
}
if (args[0] === 'exec') {
  const prompt = args[args.length - 1] || ''
  const resumed = args[1] === 'resume'
  const session = resumed ? args[args.length - 2] : '22222222-2222-2222-2222-222222222222'
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: session }) + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'item.completed', item: { type: 'agent_message', text: 'Codex reply: ' + prompt },
  }) + '\\n')
  process.exit(0)
}
process.exit(0)
`

const AGY_STUB = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'models') process.exit(0)
if (args.includes('--print')) {
  const prompt = args[args.indexOf('--print') + 1] || ''
  process.stdout.write('Gemini reply: ' + prompt)
  process.exit(0)
}
process.exit(0)
`

export interface Harness {
  config: GuiConfig
  app: ReturnType<typeof buildApp>
  accounts: AccountService
  designPanels: DesignPanelService
  locks: AdvisoryLocks
  watcher: ChangeWatcher
  sessions: SessionManager
  stdinFor: (name: string) => Buffer | null
  listen: () => Promise<string>
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
  options: {
    withController?: boolean
    maxUploadBytes?: number
    spawnTerminal?: SpawnTerminal | null
    withLauncher?: boolean
    /** Write a registry so identities have capabilities a design panel can use. */
    withDesignRegistry?: boolean
    panelRunner?: PanelCommandRunner
    panelTimeoutMs?: number
  } = {},
): Promise<Harness> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fde-gui-test-'))
  const home = path.join(root, 'home')
  const shared = path.join(home, '.claude-shared')
  const stubDir = path.join(shared, 'stub')
  const runsRoot = path.join(shared, 'runs')
  for (const dir of [path.join(shared, 'bin'), stubDir, runsRoot, path.join(shared, 'projects'), path.join(home, '.claude-profiles', 'work')]) {
    mkdirSync(dir, { recursive: true })
  }
  // Every install has an identity registry — the controller refuses to run
  // without one — so the default harness has one too. Without it the console's
  // Claude profiles have no registry key, and a run cannot be created because
  // there is no identity to hand the controller.
  mkdirSync(path.join(shared, 'config'), { recursive: true })
  const baseCapabilities = ['orchestration', 'research', 'implementation', 'review']
  writeFileSync(
    path.join(shared, 'config', 'agents.json'),
    JSON.stringify({
      roles: ['orchestrator', 'research'],
      agents: {
        claude_work: {
          label: 'Claude: work', kind: 'claude', profile: 'work',
          capabilities: baseCapabilities,
        },
        chatgpt_codex: {
          label: 'ChatGPT/Codex', kind: 'codex',
          capabilities: baseCapabilities, write_requires_approval: true,
        },
        gemini: {
          label: 'Gemini', kind: 'gemini',
          capabilities: ['research', 'review'],
        },
      },
      roleCapability: { orchestrator: 'orchestration', research: 'research' },
    }),
  )
  if (options.withDesignRegistry === true) {
    // The identity registry the controller ships, reduced to what a panel needs:
    // three Claude accounts that MAY hold the uiUxDesign role, and one that
    // deliberately may not. Replaces the default registry above.
    for (const profile of ['msc', 'alt', 'plain']) {
      mkdirSync(path.join(home, '.claude-profiles', profile), { recursive: true })
    }
    const design = ['orchestration', 'solutioning', 'ui-ux-design', 'design-system', 'review']
    writeFileSync(
      path.join(shared, 'config', 'agents.json'),
      JSON.stringify({
        roles: ['orchestrator', 'uiUxDesign'],
        agents: {
          claude_work: { label: 'Claude: work', kind: 'claude', profile: 'work', capabilities: design },
          claude_msc: { label: 'Claude: msc', kind: 'claude', profile: 'msc', capabilities: design },
          claude_alt: { label: 'Claude: alt', kind: 'claude', profile: 'alt', capabilities: design },
          claude_plain: {
            label: 'Claude: plain', kind: 'claude', profile: 'plain',
            capabilities: ['orchestration', 'research'],
          },
        },
        roleCapability: { orchestrator: 'orchestration', uiUxDesign: 'ui-ux-design' },
      }),
    )
  }
  writeFileSync(path.join(stubDir, 'calls.log'), '')

  const controllerPath = path.join(shared, 'bin', 'fde')
  if (options.withController !== false) {
    writeFileSync(controllerPath, STUB)
    chmodSync(controllerPath, 0o755)
  }
  // A launcher file only has to exist: the fake terminal backend never runs it.
  if (options.withLauncher !== false) {
    const launcher = path.join(shared, 'bin', 'fde-start')
    writeFileSync(launcher, '#!/bin/sh\nexit 0\n')
    chmodSync(launcher, 0o755)
  }
  const claudePath = path.join(shared, 'bin', 'claude-test')
  writeFileSync(claudePath, CLAUDE_STUB)
  chmodSync(claudePath, 0o755)
  const codexPath = path.join(shared, 'bin', 'codex-test')
  writeFileSync(codexPath, CODEX_STUB)
  chmodSync(codexPath, 0o755)
  const agyPath = path.join(shared, 'bin', 'agy-test')
  writeFileSync(agyPath, AGY_STUB)
  chmodSync(agyPath, 0o755)

  const token = 'test-token-not-a-real-one'
  const config = loadConfig({
    HOME: home,
    CLAUDE_SHARED: shared,
    FDE_RUNS_DIR: runsRoot,
    FDE_PROJECTS_DIR: path.join(shared, 'projects'),
    CLAUDE_PROFILES_DIR: path.join(home, '.claude-profiles'),
    FDE_GUI_TOKEN: token,
    FDE_GUI_PORT: '7317',
    FDE_CLAUDE_BIN: claudePath,
    FDE_CODEX_BIN: codexPath,
    FDE_AGY_BIN: agyPath,
    ...(options.panelTimeoutMs === undefined
      ? {}
      : { FDE_GUI_PANEL_TIMEOUT_MS: String(options.panelTimeoutMs) }),
    ...(options.maxUploadBytes === undefined
      ? {}
      : { FDE_GUI_MAX_UPLOAD_BYTES: String(options.maxUploadBytes) }),
    PATH: process.env.PATH,
  } as NodeJS.ProcessEnv)

  const locks = new AdvisoryLocks()
  const watcher = new ChangeWatcher(10)
  const sessions = new SessionManager(options.spawnTerminal ?? null)
  const accounts = new AccountService(config)
  const designPanels = new DesignPanelService(config, accounts, watcher, options.panelRunner)
  const app = buildApp(config, {
    locks, watcher, sessions, accounts, designPanels,
    chats: new ChatService(config, accounts),
  })
  await app.ready()

  return {
    config,
    app,
    accounts,
    designPanels,
    locks,
    watcher,
    sessions,
    listen: async () => {
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      return `127.0.0.1:${port}`
    },
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
