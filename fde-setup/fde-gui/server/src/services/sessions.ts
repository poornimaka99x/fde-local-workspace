import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { GuiConfig } from '../config'
import { PACKAGE_ROOT } from '../config'

/**
 * One `fde-start --resume <run-id>` process per run, and nothing else.
 *
 * This is not a shell endpoint. The manager knows one command, takes no command
 * from a caller, and can only be asked to start it for a run that already
 * exists. Everything a client can do — type, resize, interrupt — goes to that
 * one process.
 */

export interface TerminalProcess {
  readonly pid: number
  onData(listener: (chunk: string) => void): void
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface SpawnTerminalOptions {
  file: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  cols: number
  rows: number
}

export type SpawnTerminal = (options: SpawnTerminalOptions) => TerminalProcess

/**
 * node-pty is a native module. Where a platform has no prebuild and no
 * toolchain it will not be there, and the console says so plainly rather than
 * falling back to pipes: a pipe is not a terminal, and an orchestrator session
 * rendered through one would be worse than an honest refusal.
 */
export async function loadNodePty(): Promise<SpawnTerminal | null> {
  try {
    // Resolved at runtime, not at build time: this module is optional, and an
    // installation without it must still typecheck, build and start.
    const specifier: string = 'node-pty'
    const module: unknown = await import(specifier)
    const spawn = (module as { spawn?: unknown }).spawn
    if (typeof spawn !== 'function') return null
    return (options: SpawnTerminalOptions): TerminalProcess =>
      (spawn as (file: string, args: string[], opts: Record<string, unknown>) => TerminalProcess)(
        options.file,
        options.args,
        {
          name: 'xterm-256color',
          cwd: options.cwd,
          env: options.env,
          cols: options.cols,
          rows: options.rows,
        },
      )
  } catch {
    return null
  }
}

const MAX_BUFFER_BYTES = 256 * 1024
const TICKET_TTL_MS = 60_000

export interface SessionView {
  runId: string
  status: 'running' | 'exited'
  pid: number
  startedAt: string
  exitedAt: string | null
  exitCode: number | null
  cwd: string
  command: string[]
  /** Names only. A value is never read, stored or reported. */
  envKeys: string[]
  stopRequestedAt: string | null
  attachedClients: number
}

interface Session {
  runId: string
  process: TerminalProcess
  status: 'running' | 'exited'
  pid: number
  startedAt: string
  exitedAt: string | null
  exitCode: number | null
  cwd: string
  command: string[]
  envKeys: string[]
  stopRequestedAt: string | null
  /** The screen so far, capped and in memory only. Never written to disk. */
  buffer: string
  listeners: Set<(chunk: string) => void>
  exitListeners: Set<(exitCode: number) => void>
}

export class SessionExists extends Error {}
export class NoSuchSession extends Error {}
export class SessionActive extends Error {}

interface Ticket {
  runId: string
  expiresAt: number
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly tickets = new Map<string, Ticket>()

  constructor(private readonly spawnTerminal: SpawnTerminal | null) {}

  get available(): boolean {
    return this.spawnTerminal !== null
  }

  list(): SessionView[] {
    return [...this.sessions.values()].map((session) => this.view(session))
  }

  get(runId: string): SessionView | null {
    const session = this.sessions.get(runId)
    return session === undefined ? null : this.view(session)
  }

  isRunning(runId: string): boolean {
    return this.sessions.get(runId)?.status === 'running'
  }

  /**
   * Start the one command this manager knows. The run id has already been
   * validated against a real run directory by the caller; nothing here is
   * assembled from user input beyond that id.
   */
  start(options: {
    runId: string
    startBin: string
    cwd: string
    env: NodeJS.ProcessEnv
    cols?: number
    rows?: number
  }): SessionView {
    return this.startCommand({
      sessionId: options.runId,
      file: options.startBin,
      args: ['--resume', options.runId],
      cwd: options.cwd,
      env: options.env,
      cols: options.cols,
      rows: options.rows,
    })
  }

  /**
   * Start a command assembled by a trusted server route. This is deliberately
   * not an HTTP command endpoint: callers never supply file, args, cwd or env.
   * It lets the same hardened PTY/ticket lifecycle host Claude's fixed login
   * command as well as a FLOW resume.
   */
  startCommand(options: {
    sessionId: string
    file: string
    args: string[]
    cwd: string
    env: NodeJS.ProcessEnv
    cols?: number
    rows?: number
  }): SessionView {
    if (this.spawnTerminal === null) {
      throw new Error('no terminal backend')
    }
    const existing = this.sessions.get(options.sessionId)
    if (existing !== undefined && existing.status === 'running') {
      throw new SessionExists(options.sessionId)
    }
    const command = [options.file, ...options.args]
    const child = this.spawnTerminal({
      file: options.file,
      args: [...options.args],
      cwd: options.cwd,
      env: options.env,
      cols: options.cols ?? 120,
      rows: options.rows ?? 32,
    })

    const session: Session = {
      runId: options.sessionId,
      process: child,
      status: 'running',
      pid: child.pid,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
      cwd: options.cwd,
      command,
      envKeys: Object.keys(options.env).sort(),
      stopRequestedAt: null,
      buffer: '',
      listeners: new Set(),
      exitListeners: new Set(),
    }
    this.sessions.set(options.sessionId, session)

    child.onData((chunk) => {
      session.buffer += chunk
      if (session.buffer.length > MAX_BUFFER_BYTES) {
        session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER_BYTES)
      }
      for (const listener of [...session.listeners]) listener(chunk)
    })
    child.onExit(({ exitCode }) => {
      session.status = 'exited'
      session.exitCode = exitCode
      session.exitedAt = new Date().toISOString()
      for (const listener of [...session.exitListeners]) listener(exitCode)
    })

    return this.view(session)
  }

  /** Attach a viewer. Detaching never touches the process. */
  attach(
    runId: string,
    onData: (chunk: string) => void,
    onExit: (exitCode: number) => void,
  ): { backlog: string; detach: () => void; view: SessionView } {
    const session = this.sessions.get(runId)
    if (session === undefined) throw new NoSuchSession(runId)
    session.listeners.add(onData)
    session.exitListeners.add(onExit)
    return {
      backlog: session.buffer,
      view: this.view(session),
      detach: () => {
        session.listeners.delete(onData)
        session.exitListeners.delete(onExit)
      },
    }
  }

  write(runId: string, data: string): void {
    const session = this.sessions.get(runId)
    if (session === undefined || session.status !== 'running') throw new NoSuchSession(runId)
    session.process.write(data)
  }

  resize(runId: string, cols: number, rows: number): void {
    const session = this.sessions.get(runId)
    if (session === undefined || session.status !== 'running') return
    session.process.resize(Math.max(1, Math.min(cols, 500)), Math.max(1, Math.min(rows, 200)))
  }

  /**
   * Stop asks first. An interrupt gives the session a chance to end the way it
   * would in a terminal; a force stop is a separate, deliberate second action.
   */
  stop(runId: string, options: { force?: boolean } = {}): SessionView {
    const session = this.sessions.get(runId)
    if (session === undefined) throw new NoSuchSession(runId)
    if (session.status === 'running') {
      session.stopRequestedAt = new Date().toISOString()
      session.process.kill(options.force === true ? 'SIGKILL' : 'SIGINT')
    }
    return this.view(session)
  }

  /** Forget only finished, in-memory console history. The durable run is untouched. */
  delete(runId: string): SessionView {
    const session = this.sessions.get(runId)
    if (session === undefined) throw new NoSuchSession(runId)
    if (session.status === 'running') throw new SessionActive(runId)
    this.sessions.delete(runId)
    for (const [ticket, value] of this.tickets) {
      if (value.runId === runId) this.tickets.delete(ticket)
    }
    return this.view(session)
  }

  issueTicket(runId: string): string {
    this.pruneTickets()
    const ticket = randomBytes(32).toString('base64url')
    this.tickets.set(ticket, { runId, expiresAt: Date.now() + TICKET_TTL_MS })
    return ticket
  }

  /** Is this ticket usable for this run? Checked before the upgrade; not spent. */
  peekTicket(ticket: string, runId: string): boolean {
    this.pruneTickets()
    const found = this.tickets.get(ticket)
    return found !== undefined && found.runId === runId && found.expiresAt > Date.now()
  }

  /** Single use, short-lived, and bound to one run. */
  redeemTicket(ticket: string, runId: string): boolean {
    this.pruneTickets()
    const found = this.tickets.get(ticket)
    if (found === undefined) return false
    this.tickets.delete(ticket)
    return found.runId === runId && found.expiresAt > Date.now()
  }

  /**
   * On shutdown the sessions become unreachable, so they are hung up rather
   * than left as orphans. The run itself is durable: `fde-start --resume` picks
   * up the same conversation afterwards.
   */
  shutdown(): void {
    for (const session of this.sessions.values()) {
      if (session.status === 'running') {
        try {
          session.process.kill('SIGHUP')
        } catch {
          /* it may already be gone */
        }
      }
    }
    this.tickets.clear()
  }

  private pruneTickets(): void {
    const now = Date.now()
    for (const [ticket, value] of this.tickets) {
      if (value.expiresAt <= now) this.tickets.delete(ticket)
    }
  }

  private view(session: Session): SessionView {
    return {
      runId: session.runId,
      status: session.status,
      pid: session.pid,
      startedAt: session.startedAt,
      exitedAt: session.exitedAt,
      exitCode: session.exitCode,
      cwd: session.cwd,
      command: session.command,
      envKeys: session.envKeys,
      stopRequestedAt: session.stopRequestedAt,
      attachedClients: session.listeners.size,
    }
  }
}

/** Names that must never be passed to a session, whatever is in the operator shell. */
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|COOKIE|SESSION/i

/**
 * The environment a FLOW profile actually needs, and nothing else. Anything
 * secret-looking is dropped even if it somehow reaches the allowlist, so a
 * diagnostic listing env names can never name one.
 */
export function sessionEnv(config: GuiConfig): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    HOME: config.home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    // Claude Code uses the macOS account name when resolving credentials from
    // Keychain. This is identity metadata, not a credential, and is the only
    // extra operator-shell value its auth lookup needs.
    USER: process.env.USER ?? path.basename(config.home),
    CLAUDE_SHARED: config.sharedRoot,
    FDE_RUNS_DIR: config.runsRoot,
    FDE_PROJECTS_DIR: config.projectsRoot,
    CLAUDE_PROFILES_DIR: config.profilesRoot,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  }
  // Installation overrides, when the operator set them for this server.
  for (const name of ['FDE_CONTROLLER', 'FDE_MCP_SYNC', 'FDE_CLAUDE_BIN', 'FDE_CODEX_BIN'] as const) {
    const value = process.env[name]
    if (typeof value === 'string' && value !== '') base[name] = value
  }
  for (const name of Object.keys(base)) {
    if (SECRET_NAME.test(name)) delete base[name]
  }
  return base
}

/**
 * Where the session runs: the project's first configured repository, or the
 * server's own safe directory when the run has no project or the path is not a
 * usable directory.
 */
export function sessionCwd(config: GuiConfig, repoPaths: readonly string[], exists: (p: string) => boolean): string {
  for (const repo of repoPaths) {
    if (path.isAbsolute(repo) && exists(repo)) return repo
  }
  return exists(config.sharedRoot) ? config.sharedRoot : PACKAGE_ROOT
}
