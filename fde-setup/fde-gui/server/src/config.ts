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
  home: string
  sharedRoot: string
  runsRoot: string
  projectsRoot: string
  profilesRoot: string
  webRoot: string
  version: string
  apiVersion: number
  controllerTimeoutMs: number
  maxTextPreviewBytes: number
  bodyLimitBytes: number
  maxUploadBytes: number
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
  const profilesRoot = path.resolve(
    env.CLAUDE_PROFILES_DIR?.trim() || path.join(home, '.claude-profiles'),
  )
  const fdeBin = path.resolve(env.FDE_CONTROLLER?.trim() || path.join(sharedRoot, 'bin', 'fde'))
  const fdeStartBin = path.resolve(env.FDE_START_BIN?.trim() || path.join(sharedRoot, 'bin', 'fde-start'))

  return {
    host,
    port: intFrom(env.FDE_GUI_PORT, 7317, 'FDE_GUI_PORT'),
    token: env.FDE_GUI_TOKEN?.trim() || randomBytes(32).toString('base64url'),
    fdeBin,
    fdeStartBin,
    home,
    sharedRoot,
    runsRoot,
    projectsRoot,
    profilesRoot,
    webRoot: path.join(PACKAGE_ROOT, 'dist', 'web'),
    version: readVersion(),
    apiVersion: 1,
    controllerTimeoutMs: intFrom(env.FDE_GUI_CONTROLLER_TIMEOUT_MS, 20000, 'FDE_GUI_CONTROLLER_TIMEOUT_MS'),
    maxTextPreviewBytes: 1024 * 1024,
    bodyLimitBytes: 64 * 1024,
    // The controller's own ceiling. Configurable downward only, like the
    // controller's: neither a caller nor an environment may raise it.
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
