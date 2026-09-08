import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export interface GuiConfig {
  host: string
  port: number
  /** Unguessable, regenerated every launch, never logged. */
  token: string
  fdeBin: string
  fdeStartBin: string
  claudeBin: string
  codexBin: string
  agyBin: string
  home: string
  sharedRoot: string
  runsRoot: string
  projectsRoot: string
  chatsRoot: string
  profilesRoot: string
  /**
   * Where per-account credential directories live for the providers that gained
   * them with AI accounts. These mirror the defaults in the controller's
   * provider templates, and are overridable by the same variables, so the
   * console and the CLI never disagree about which directory holds which
   * account's login.
   */
  codexProfilesRoot: string
  copilotProfilesRoot: string
  webRoot: string
  version: string
  apiVersion: number
  controllerTimeoutMs: number
  maxTextPreviewBytes: number
  bodyLimitBytes: number
  maxUploadBytes: number
  /** One design-panel participant's wall-clock ceiling. */
  panelTimeoutMs: number
  /** How many participant subprocesses this console will run at once. */
  panelConcurrency: number
  /** The largest proposal this console will carry back to the controller. */
  panelMaxProposalBytes: number
}

/** The GUI is a local operator console. It never listens anywhere else. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

function readVersion(): string {
  try {
    const raw = readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'version' in parsed) {
      return String((parsed as { version: unknown }).version)
    }
  } catch {
    /* a missing package.json is not a reason to refuse to start */
  }
  return '0.0.0'
}

function intFrom(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer, got ${JSON.stringify(value)}`)
  }
  return parsed
}

function resolveCliBin(name: 'claude' | 'codex' | 'agy', override: string | undefined, env: NodeJS.ProcessEnv): string {
  if (override?.trim()) return override.trim()
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue
    const candidate = path.join(directory, name)
    if (isExecutable(candidate)) return candidate
  }
  // Claude Desktop's claude-code-vm contains a Linux guest binary on macOS;
  // it must not be mistaken for a host CLI. The native `claude` command must
  // be installed on PATH or named explicitly with FDE_CLAUDE_BIN.
  return name
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GuiConfig {
  const host = env.FDE_GUI_HOST?.trim() || '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `refusing to bind to ${host}: the FDE Control Center is a local console and ` +
        'listens on loopback only',
    )
  }
  const home = env.HOME?.trim() || os.homedir()
  const sharedRoot = path.resolve(env.CLAUDE_SHARED?.trim() || path.join(home, '.claude-shared'))
  const runsRoot = path.resolve(env.FDE_RUNS_DIR?.trim() || path.join(sharedRoot, 'runs'))
  const projectsRoot = path.resolve(env.FDE_PROJECTS_DIR?.trim() || path.join(sharedRoot, 'projects'))
  const chatsRoot = path.resolve(env.FDE_CHATS_DIR?.trim() || path.join(sharedRoot, 'chats'))
  const profilesRoot = path.resolve(
    env.CLAUDE_PROFILES_DIR?.trim() || path.join(home, '.claude-profiles'),
  )
  const codexProfilesRoot = path.resolve(
    env.FDE_CODEX_PROFILES_DIR?.trim() || path.join(home, '.codex-profiles'),
  )
  const copilotProfilesRoot = path.resolve(
    env.FDE_COPILOT_PROFILES_DIR?.trim() || path.join(home, '.fde-copilot'),
  )
  const fdeBin = path.resolve(env.FDE_CONTROLLER?.trim() || path.join(sharedRoot, 'bin', 'fde'))
  const fdeStartBin = path.resolve(env.FDE_START_BIN?.trim() || path.join(sharedRoot, 'bin', 'fde-start'))

  return {
    host,
    port: intFrom(env.FDE_GUI_PORT, 7317, 'FDE_GUI_PORT'),
    token: env.FDE_GUI_TOKEN?.trim() || randomBytes(32).toString('base64url'),
    fdeBin,
    fdeStartBin,
    claudeBin: resolveCliBin('claude', env.FDE_CLAUDE_BIN, env),
    codexBin: resolveCliBin('codex', env.FDE_CODEX_BIN, env),
    agyBin: resolveCliBin('agy', env.FDE_AGY_BIN, env),
    home,
    sharedRoot,
    runsRoot,
    projectsRoot,
    chatsRoot,
    profilesRoot,
    codexProfilesRoot,
    copilotProfilesRoot,
    webRoot: path.join(PACKAGE_ROOT, 'dist', 'web'),
    version: readVersion(),
    apiVersion: 1,
    controllerTimeoutMs: intFrom(env.FDE_GUI_CONTROLLER_TIMEOUT_MS, 20000, 'FDE_GUI_CONTROLLER_TIMEOUT_MS'),
    maxTextPreviewBytes: 1024 * 1024,
    bodyLimitBytes: 64 * 1024,
    // The controller's own ceiling. Configurable downward only, like the
    // controller's: neither a caller nor an environment may raise it.
    panelTimeoutMs: intFrom(env.FDE_GUI_PANEL_TIMEOUT_MS, 900_000, 'FDE_GUI_PANEL_TIMEOUT_MS'),
    // Three is the panel ceiling in the controller too: a panel is two or three
    // accounts, and running more processes than that would mean running
    // something this console was not asked to run.
    panelConcurrency: Math.min(3, intFrom(env.FDE_GUI_PANEL_CONCURRENCY, 3, 'FDE_GUI_PANEL_CONCURRENCY') || 3),
    panelMaxProposalBytes: Math.min(
      1024 * 1024,
      intFrom(env.FDE_GUI_PANEL_MAX_PROPOSAL_BYTES, 1024 * 1024, 'FDE_GUI_PANEL_MAX_PROPOSAL_BYTES') ||
        1024 * 1024,
    ),
    maxUploadBytes: Math.min(
      100 * 1024 * 1024,
      intFrom(env.FDE_GUI_MAX_UPLOAD_BYTES, 100 * 1024 * 1024, 'FDE_GUI_MAX_UPLOAD_BYTES') ||
        100 * 1024 * 1024,
    ),
  }
}

export function isExecutable(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}
