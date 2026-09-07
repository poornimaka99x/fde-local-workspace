import { execFile, spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import os from 'node:os'
import type { GuiConfig } from '../config'

/**
 * Every controller call is a direct spawn of the `fde` binary with an argument
 * array. No shell, no string concatenation, no interpolation of anything a
 * caller supplied. Identifiers are validated against these patterns before they
 * are allowed near argv at all.
 */
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/

export class ControllerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'ControllerError'
  }
}

/**
 * Exit codes this controller documents. Their stderr is a deliberate, written
 * refusal and is worth showing. Anything else — an unhandled exception, say —
 * is an unknown string that may carry a traceback, so it never reaches the
 * browser.
 */
const DOCUMENTED_EXITS = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10])

/**
 * An argparse refusal of a subcommand or flag we know exists means the binary
 * on disk predates these contracts. That is an installation problem with a
 * one-line fix, not a workflow refusal, and it deserves to be said that way
 * rather than pasted as a usage string.
 */
const OUTDATED = /invalid choice|unrecognized arguments|no such option/i

export function looksOutdated(exitCode: number, text: string): boolean {
  return exitCode === 2 && OUTDATED.test(text)
}

function safeDetail(exitCode: number, text: string): string | undefined {
  if (!DOCUMENTED_EXITS.has(exitCode)) return undefined
  const trimmed = text.trim()
  if (trimmed === '' || /Traceback \(most recent call last\)/.test(trimmed)) return undefined
  return trimmed.slice(0, 2000)
}

/** Controller exit codes, mapped to something an HTTP client can act on. */
function statusForExit(code: number): { status: number; problem: string } {
  switch (code) {
    case 2:
      return { status: 400, problem: 'controller-rejected-input' }
    case 4:
      return { status: 404, problem: 'not-found' }
    case 3:
    case 5:
    case 6:
    case 7:
    case 8:
    case 9:
    case 10:
      // A gate, a guard, or an illegal transition. The controller's own words
      // are the useful part; the GUI shows them and offers no way around them.
      return { status: 409, problem: 'controller-refused' }
    default:
      return { status: 502, problem: 'controller-failed' }
  }
}

/**
 * The child gets only the environment the installed FDE/Claude profiles need.
 * Everything else — tokens, keys, Direct Line secrets — is left behind.
 */
export function controllerEnv(config: GuiConfig): NodeJS.ProcessEnv {
  return {
    HOME: config.home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    CLAUDE_SHARED: config.sharedRoot,
    FDE_RUNS_DIR: config.runsRoot,
    FDE_PROJECTS_DIR: config.projectsRoot,
    FDE_CHATS_DIR: config.chatsRoot,
    CLAUDE_PROFILES_DIR: config.profilesRoot,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    ...(process.env.PYTHONPATH ? { PYTHONPATH: process.env.PYTHONPATH } : {}),
  }
}

export function outdatedControllerError(
  config: GuiConfig,
  args: readonly string[],
): ControllerError {
  return new ControllerError(
    503,
    'controller-outdated',
    'The installed controller is older than this console.',
    `${config.fdeBin} does not understand "fde ${args.filter((a) => !a.startsWith('-')).join(' ')} --json", ` +
      'so it predates the machine-readable contracts (schema 1) the console needs. ' +
      'Update it by running ./install.sh from your fde-setup checkout, or point ' +
      'FDE_CONTROLLER at an updated fde.',
  )
}

export async function runController(
  config: GuiConfig,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  if (!existsSync(config.fdeBin)) {
    throw new ControllerError(
      503,
      'controller-unavailable',
      'The fde controller is not available.',
      `No controller at ${config.fdeBin}. Set FDE_CONTROLLER if it lives elsewhere.`,
    )
  }
  const cwd = existsSync(config.sharedRoot) ? config.sharedRoot : os.tmpdir()
  return await new Promise((resolve, reject) => {
    execFile(
      config.fdeBin,
      [...args],
      {
        cwd,
        env: controllerEnv(config),
        timeout: config.controllerTimeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr })
          return
        }
        const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true
        if (killed) {
          reject(
            new ControllerError(504, 'controller-timeout', 'The controller did not answer in time.'),
          )
          return
        }
        const exitCode = typeof error.code === 'number' ? error.code : null
        if (exitCode === null) {
          reject(
            new ControllerError(
              502,
              'controller-failed',
              'The controller could not be run.',
              String(error.message ?? '').slice(0, 500),
            ),
          )
          return
        }
        const output = stderr || stdout
        if (looksOutdated(exitCode, output)) {
          reject(outdatedControllerError(config, args))
          return
        }
        const mapped = statusForExit(exitCode)
        reject(
          new ControllerError(
            mapped.status,
            mapped.problem,
            DOCUMENTED_EXITS.has(exitCode)
              ? 'The controller refused this request.'
              : 'The controller failed.',
            safeDetail(exitCode, output),
          ),
        )
      },
    )
  })
}

export async function runControllerJson(
  config: GuiConfig,
  args: readonly string[],
): Promise<unknown> {
  const { stdout } = await runController(config, args)
  try {
    return JSON.parse(stdout) as unknown
  } catch {
    throw new ControllerError(
      502,
      'controller-unreadable',
      'The controller returned something that is not JSON.',
    )
  }
}


/**
 * The same spawn discipline, with the request body written to the child's
 * stdin.
 *
 * This is the only way a browser upload reaches disk: the bytes go to
 * `fde attach --stdin --name <name>`, which sanitizes the name, generates the
 * stored filename, hashes what it wrote and appends the audit record. A
 * filename from a browser never becomes a path or a command line here, and the
 * console never writes into a run directory itself.
 */
export async function runControllerWithStdin(
  config: GuiConfig,
  args: readonly string[],
  body: Readable,
  limitBytes: number,
): Promise<unknown> {
  if (!existsSync(config.fdeBin)) {
    throw new ControllerError(
      503,
      'controller-unavailable',
      'The fde controller is not available.',
      `No controller at ${config.fdeBin}.`,
    )
  }
  const child = spawn(config.fdeBin, [...args], {
    cwd: existsSync(config.sharedRoot) ? config.sharedRoot : os.tmpdir(),
    env: controllerEnv(config),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    if (stdout.length < 1_000_000) stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 100_000) stderr += chunk
  })

  const finished = new Promise<number>((resolve, reject) => {
    child.on('error', (error: NodeJS.ErrnoException) =>
      reject(
        new ControllerError(502, 'controller-failed', 'The controller could not be run.', error.code),
      ),
    )
    child.on('close', (code) => resolve(code ?? 1))
  })

  const timer = setTimeout(() => child.kill('SIGKILL'), config.controllerTimeoutMs)
  let received = 0
  let overLimit = false
  try {
    await new Promise<void>((resolve, reject) => {
      body.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > limitBytes) {
          overLimit = true
          body.destroy()
          child.kill('SIGKILL')
          reject(
            new ControllerError(
              413,
              'attachment-too-large',
              'That upload is larger than this console accepts.',
              `The limit is ${limitBytes} bytes.`,
            ),
          )
          return
        }
        if (!child.stdin.write(chunk)) {
          body.pause()
          child.stdin.once('drain', () => body.resume())
        }
      })
      body.on('error', (error: Error) => reject(
        new ControllerError(400, 'upload-interrupted', 'The upload did not finish.', error.message),
      ))
      body.on('end', () => {
        child.stdin.end()
        resolve()
      })
      child.stdin.on('error', () => {
        // The controller closed stdin first — its exit code is the real answer.
        resolve()
      })
    })
    const exitCode = await finished
    if (exitCode !== 0) {
      if (looksOutdated(exitCode, stderr || stdout)) throw outdatedControllerError(config, args)
      const mapped = statusForExit(exitCode)
      throw new ControllerError(
        mapped.status,
        mapped.problem,
        DOCUMENTED_EXITS.has(exitCode)
          ? 'The controller refused this upload.'
          : 'The controller failed.',
        safeDetail(exitCode, stderr || stdout),
      )
    }
    try {
      return JSON.parse(stdout) as unknown
    } catch {
      throw new ControllerError(
        502,
        'controller-unreadable',
        'The controller returned something that is not JSON.',
      )
    }
  } finally {
    clearTimeout(timer)
    if (overLimit) await finished.catch(() => 1)
  }
}
