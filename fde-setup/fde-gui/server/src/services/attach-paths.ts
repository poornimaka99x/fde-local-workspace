import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * The one check for "may the operator point the console at this local path as
 * an attachment". Chats and new runs both use it, so a path one of them refuses
 * the other refuses too.
 *
 * It answers with the resolved path and whether it is a file or a folder. It
 * reads nothing but metadata; what happens next (inline it into a chat, copy it
 * into a run with `fde attach`, grant a folder with `--context-dir`) is the
 * caller's business, and the controller re-checks what it is given.
 */
export const SENSITIVE_SEGMENTS = new Set([
  '.ssh', '.aws', '.gnupg', '.kube', '.git', 'keychains', 'mcp',
  '.claude', '.claude-profiles', '.claude-shared', '.codex', '.gemini', '.copilot',
])
export const SENSITIVE_FILE = /^(?:\.credentials\.json|credentials(?:\.json)?|orchestrator-session-id|\.netrc|\.npmrc|\.pypirc|\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i

export class InvalidAttachPath extends Error {}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function resolvedOr(value: string): Promise<string> {
  try {
    return await realpath(value)
  } catch {
    // A configured root need not exist yet. Its resolved path is still enough
    // to refuse a future path beneath it.
    return path.resolve(value)
  }
}

export interface AttachPathPolicy {
  /** The operator's home folder. */
  home: string
  /** Account profiles: never attachable, even though they sit under home. */
  profilesRoot: string
  /** Further folders a path may live in (the chat's or run's own folder). */
  extraRoots?: readonly string[]
  /** Noun used in messages: "chat", "run". */
  noun?: string
}

export async function checkAttachPath(
  requestedPath: string,
  policy: AttachPathPolicy,
): Promise<{ path: string; kind: 'file' | 'directory' }> {
  const noun = policy.noun ?? 'selected project'
  if (!path.isAbsolute(requestedPath) || requestedPath.includes('\0')) {
    throw new InvalidAttachPath('Only an absolute path can be attached.')
  }
  let real: string
  try {
    real = await realpath(requestedPath)
  } catch {
    throw new InvalidAttachPath('That path does not exist.')
  }
  const realProfilesRoot = await resolvedOr(policy.profilesRoot)
  const roots = [await resolvedOr(policy.home)]
  for (const extra of policy.extraRoots ?? []) roots.push(await resolvedOr(extra))
  const segments = real.split(path.sep).map((segment) => segment.toLowerCase())
  const basename = path.basename(real)
  const envExample = /^\.env\.(?:example|sample|template)$/i.test(basename)
  if (!roots.some((root) => isInside(root, real))) {
    throw new InvalidAttachPath(`Only paths inside your home folder or the ${noun} can be attached.`)
  }
  if (
    isInside(realProfilesRoot, real) ||
    segments.some((segment) => SENSITIVE_SEGMENTS.has(segment)) ||
    (!envExample && SENSITIVE_FILE.test(basename))
  ) {
    throw new InvalidAttachPath('Credential, key and private configuration paths cannot be attached.')
  }
  let info
  try {
    info = await stat(real)
  } catch {
    throw new InvalidAttachPath('That path could not be read.')
  }
  if (!info.isFile() && !info.isDirectory()) {
    throw new InvalidAttachPath('Only files and folders can be attached.')
  }
  return { path: real, kind: info.isDirectory() ? 'directory' : 'file' }
}
