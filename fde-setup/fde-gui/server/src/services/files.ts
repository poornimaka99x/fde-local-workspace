import { createReadStream, type Stats } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'

/**
 * Read-only access to one run directory, and nothing else on the machine.
 *
 * Two rules do the work here:
 *   - a path is resolved *and then* checked to still be inside the run root, so
 *     a symlinked intermediate directory cannot walk out;
 *   - symlinks are never followed, listed as targets, previewed or downloaded.
 */

export type PreviewKind = 'text' | 'markdown' | 'json' | 'image' | 'pdf' | 'none'

export interface RunFileEntry {
  path: string
  name: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  size: number | null
  modifiedAt: string | null
  mediaType: string
  preview: PreviewKind
  downloadable: boolean
}

export interface FileListing {
  entries: RunFileEntry[]
  truncated: boolean
  withheld: string[]
}

/**
 * Paths the console will not serve as files.
 *
 * The approval ledger is shown as a redacted structured view, never handed over
 * as a download. Run-scoped MCP configuration can carry connector headers, and
 * the orchestrator session id is a resume token — neither belongs in a file
 * browser.
 */
const WITHHELD_FILES = new Set(['approvals.jsonl', 'orchestrator-session-id'])
const WITHHELD_DIRS = new Set(['mcp'])
const WITHHELD_PATTERNS = [
  /^\.env/i,
  /(^|[-_.])credentials?([-_.]|$)/i,
  /\.(pem|key|p12|pfx|keychain)$/i,
]

const MAX_ENTRIES = 2000
const MAX_DEPTH = 8

interface TypeRule {
  mediaType: string
  preview: PreviewKind
  inline: boolean
}

/**
 * An allowlist, by extension. Anything not named here is served as an opaque
 * download: HTML, SVG, JavaScript and Office documents included, so nothing
 * active is ever executed or rendered by the browser in this origin.
 */
const TYPE_RULES: Record<string, TypeRule> = {
  '.md': { mediaType: 'text/markdown', preview: 'markdown', inline: true },
  '.markdown': { mediaType: 'text/markdown', preview: 'markdown', inline: true },
  '.txt': { mediaType: 'text/plain', preview: 'text', inline: true },
  '.log': { mediaType: 'text/plain', preview: 'text', inline: true },
  '.csv': { mediaType: 'text/plain', preview: 'text', inline: true },
  '.tsv': { mediaType: 'text/plain', preview: 'text', inline: true },
  '.yaml': { mediaType: 'text/plain', preview: 'text', inline: true },
  '.yml': { mediaType: 'text/plain', preview: 'text', inline: true },
  '.toml': { mediaType: 'text/plain', preview: 'text', inline: true },
  '.ini': { mediaType: 'text/plain', preview: 'text', inline: true },
  '.jsonl': { mediaType: 'text/plain', preview: 'text', inline: true },
  '.json': { mediaType: 'application/json', preview: 'json', inline: true },
  '.png': { mediaType: 'image/png', preview: 'image', inline: true },
  '.jpg': { mediaType: 'image/jpeg', preview: 'image', inline: true },
  '.jpeg': { mediaType: 'image/jpeg', preview: 'image', inline: true },
  '.webp': { mediaType: 'image/webp', preview: 'image', inline: true },
  '.gif': { mediaType: 'image/gif', preview: 'image', inline: true },
  '.pdf': { mediaType: 'application/pdf', preview: 'pdf', inline: true },
}

const OPAQUE: TypeRule = {
  mediaType: 'application/octet-stream',
  preview: 'none',
  inline: false,
}

export function typeRuleFor(relativePath: string): TypeRule {
  return TYPE_RULES[path.extname(relativePath).toLowerCase()] ?? OPAQUE
}

export function isWithheld(relativePath: string): boolean {
  const segments = relativePath.split('/')
  if (segments.some((segment) => WITHHELD_DIRS.has(segment))) return true
  const name = segments[segments.length - 1] ?? ''
  if (WITHHELD_FILES.has(relativePath) || WITHHELD_FILES.has(name)) return true
  return WITHHELD_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * Resolve `<runsRoot>/<runId>` and prove it is a real directory sitting directly
 * in the runs root. A run id is a name, never a path, and a symlink standing in
 * for a run would make every containment check below meaningless — so both are
 * refused before a single byte is read.
 */
export async function resolveRunDirectory(runsRoot: string, runId: string): Promise<string> {
  if (runId === '' || runId.includes('/') || runId.includes('\\') || runId === '.' || runId === '..') {
    throw new FilePathError(400, 'invalid-run-id', 'That is not a valid run id.')
  }
  let root: string
  try {
    root = await realpath(runsRoot)
  } catch {
    throw new FilePathError(404, 'not-found', 'The runs directory does not exist.')
  }
  const candidate = path.join(root, runId)
  let stats: Stats
  try {
    stats = await lstat(candidate)
  } catch {
    throw new FilePathError(404, 'not-found', 'No such run.')
  }
  if (stats.isSymbolicLink()) {
    throw new FilePathError(403, 'symlink', 'That run is a symlink; the console will not read through it.')
  }
  if (!stats.isDirectory()) {
    throw new FilePathError(404, 'not-found', 'No such run.')
  }
  const real = await realpath(candidate)
  if (path.dirname(real) !== root) {
    throw new FilePathError(403, 'outside-run', 'That run resolves outside the runs directory.')
  }
  return real
}

export class FilePathError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'FilePathError'
  }
}

/** Reject anything that is not a plain, relative, downward path. */
export function normalizeRelativePath(input: string): string {
  const raw = (input ?? '').trim()
  if (raw === '') throw new FilePathError(400, 'invalid-path', 'A file path is required.')
  if (raw.includes('\0')) throw new FilePathError(400, 'invalid-path', 'Invalid file path.')
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new FilePathError(400, 'invalid-path', 'Only paths inside the run are allowed.')
  }
  const segments = raw.replace(/\\/g, '/').split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new FilePathError(400, 'invalid-path', 'Only paths inside the run are allowed.')
    }
  }
  return segments.join('/')
}

export interface ResolvedFile {
  absolutePath: string
  relativePath: string
  stats: Stats
}

/**
 * Resolve a path inside a run and prove it stayed there. `realpath` collapses
 * every symlink; if the result is not the path we asked for, something in the
 * chain was a link and the request is refused.
 */
export async function resolveRunFile(runDir: string, requested: string): Promise<ResolvedFile> {
  // `runDir` must already have come from resolveRunDirectory().
  const relativePath = normalizeRelativePath(requested)
  if (isWithheld(relativePath)) {
    throw new FilePathError(
      403,
      'withheld',
      'That file is not served by the console. Approval records are shown as a redacted view.',
    )
  }
  const runRoot = runDir
  const absolutePath = path.resolve(runRoot, relativePath)
  if (absolutePath !== path.normalize(absolutePath) || !absolutePath.startsWith(runRoot + path.sep)) {
    throw new FilePathError(403, 'outside-run', 'That path is outside the run directory.')
  }

  let stats: Stats
  try {
    stats = await lstat(absolutePath)
  } catch {
    throw new FilePathError(404, 'not-found', 'No such file in this run.')
  }
  if (stats.isSymbolicLink()) {
    throw new FilePathError(403, 'symlink', 'Symlinks are not followed by the console.')
  }
  if (!stats.isFile()) {
    throw new FilePathError(400, 'not-a-file', 'That path is not a regular file.')
  }
  const real = await realpath(absolutePath)
  if (real !== absolutePath || !real.startsWith(runRoot + path.sep)) {
    throw new FilePathError(403, 'outside-run', 'That path resolves outside the run directory.')
  }
  return { absolutePath, relativePath, stats }
}

export async function listRunFiles(runDir: string): Promise<FileListing> {
  const entries: RunFileEntry[] = []
  const withheld: string[] = []
  let truncated = false
  const runRoot = runDir

  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || truncated) return
    let listing
    try {
      listing = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of listing.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true
        return
      }
      const relativePath = prefix === '' ? item.name : `${prefix}/${item.name}`
      if (isWithheld(relativePath)) {
        withheld.push(relativePath)
        continue
      }
      const absolute = path.join(directory, item.name)
      if (item.isSymbolicLink()) {
        entries.push({
          path: relativePath,
          name: item.name,
          kind: 'symlink',
          size: null,
          modifiedAt: null,
          mediaType: 'application/octet-stream',
          preview: 'none',
          downloadable: false,
        })
        continue
      }
      if (item.isDirectory()) {
        entries.push({
          path: relativePath,
          name: item.name,
          kind: 'directory',
          size: null,
          modifiedAt: null,
          mediaType: 'inode/directory',
          preview: 'none',
          downloadable: false,
        })
        await walk(absolute, relativePath, depth + 1)
        continue
      }
      if (!item.isFile()) {
        entries.push({
          path: relativePath,
          name: item.name,
          kind: 'other',
          size: null,
          modifiedAt: null,
          mediaType: 'application/octet-stream',
          preview: 'none',
          downloadable: false,
        })
        continue
      }
      let stats: Stats | null = null
      try {
        stats = await lstat(absolute)
      } catch {
        stats = null
      }
      const rule = typeRuleFor(relativePath)
      entries.push({
        path: relativePath,
        name: item.name,
        kind: 'file',
        size: stats ? stats.size : null,
        modifiedAt: stats ? new Date(stats.mtimeMs).toISOString() : null,
        mediaType: rule.mediaType,
        preview: rule.preview,
        downloadable: true,
      })
    }
  }

  await walk(runRoot, '', 0)
  return { entries, truncated, withheld }
}

export function openFileStream(file: ResolvedFile, limitBytes?: number): Readable {
  if (limitBytes !== undefined && file.stats.size > limitBytes) {
    return createReadStream(file.absolutePath, { start: 0, end: limitBytes - 1 })
  }
  return createReadStream(file.absolutePath)
}
