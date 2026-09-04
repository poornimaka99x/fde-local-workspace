import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * A general local-filesystem browser: names, kinds and sizes only, never file
 * content. This console already runs the operator's own shell commands with
 * the operator's own credentials (Claude login, `fde` itself); listing
 * directory names anywhere on the machine is not a materially larger trust
 * boundary than that, and it is what lets the operator point the console at a
 * real repository or file without retyping an absolute path by hand.
 *
 * Symlinks are followed for navigation (so a symlinked repo checkout can be
 * browsed into, the way Finder or `cd` would), unlike the sandboxed run-file
 * browser in files.ts, which never follows them. There is no containment
 * root here by design: this endpoint is a "choose a folder" dialog, not a
 * boundary around one run.
 */

export class BrowsePathError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface BrowseEntry {
  name: string
  path: string
  kind: 'directory' | 'file' | 'other'
  symlink: boolean
  size: number | null
  modifiedAt: string | null
}

export interface BrowseResult {
  path: string
  parent: string | null
  entries: BrowseEntry[]
  truncated: boolean
}

const MAX_ENTRIES = 1000
const PRIVATE_DIRECTORY_NAMES = new Set([
  '.ssh', '.aws', '.gnupg', '.kube', '.git', '.claude', '.claude-profiles',
  '.claude-shared', '.codex', '.gemini', '.copilot', 'keychains',
])
const PRIVATE_FILE_NAME = /^(?:\.credentials\.json|credentials(?:\.json)?|orchestrator-session-id|\.netrc|\.npmrc|\.pypirc|\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i

export async function browseDirectory(requested: string | undefined, home: string): Promise<BrowseResult> {
  const raw = (requested ?? '').trim()
  if (raw.includes('\0')) throw new BrowsePathError(400, 'invalid-path', 'Invalid path.')
  const candidate = raw === '' ? home : path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(home, raw)

  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    throw new BrowsePathError(404, 'not-found', 'That path does not exist.')
  }

  let info
  try {
    info = await stat(real)
  } catch {
    throw new BrowsePathError(404, 'not-found', 'That path does not exist.')
  }
  if (!info.isDirectory()) {
    throw new BrowsePathError(400, 'not-a-directory', 'That path is not a folder.')
  }

  let listing
  try {
    listing = await readdir(real, { withFileTypes: true })
  } catch {
    throw new BrowsePathError(403, 'unreadable', 'That folder could not be read.')
  }

  const entries: BrowseEntry[] = []
  let truncated = false
  for (const item of listing.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
    const envExample = /^\.env\.(?:example|sample|template)$/i.test(item.name)
    if (
      PRIVATE_DIRECTORY_NAMES.has(item.name.toLowerCase()) ||
      (!envExample && PRIVATE_FILE_NAME.test(item.name))
    ) continue
    const absolute = path.join(real, item.name)
    const symlink = item.isSymbolicLink()
    let kind: BrowseEntry['kind'] = 'other'
    let size: number | null = null
    let modifiedAt: string | null = null
    try {
      // Follows a symlink for navigation purposes only; nothing is read.
      const followed = await stat(absolute)
      kind = followed.isDirectory() ? 'directory' : followed.isFile() ? 'file' : 'other'
      size = followed.isFile() ? followed.size : null
      modifiedAt = new Date(followed.mtimeMs).toISOString()
    } catch {
      // A broken symlink or a permission error still shows up in the listing.
    }
    entries.push({ name: item.name, path: absolute, kind, symlink, size, modifiedAt })
  }

  const parent = path.dirname(real) === real ? null : path.dirname(real)
  return { path: real, parent, entries, truncated }
}
