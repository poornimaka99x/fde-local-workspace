import type WebSocket from 'ws'
import type { Services } from '../services/types'

/**
 * Every session key that signs in to one credential directory.
 *
 * There are two sign-in surfaces — the chat-accounts screen, keyed by Claude
 * profile, and the AI-accounts screen, keyed by registry identity — and the
 * "one at a time" guard is per key. Two keys pointing at the same
 * CLAUDE_CONFIG_DIR would let both run `claude auth login` against it at once,
 * with whichever finished last deciding what the credential is. This is how a
 * route asks whether the other surface already has one running.
 */
export function loginKeysFor(profile: string | null, accountId: string): string[] {
  const keys = [`account-login:${accountId}`]
  if (profile !== null && profile !== '') keys.push(`login:${profile}`)
  return keys
}

/** The first of these keys with a sign-in already running, if any. */
export function runningLogin(sessions: Services['sessions'], keys: string[]): string | null {
  return keys.find((key) => sessions.isRunning(key)) ?? null
}

/**
 * Attach one browser socket to one running terminal session.
 *
 * Shared by every interactive surface — a chat account sign-in, an AI-account
 * sign-in, a run session — because they all need the identical discipline:
 * the socket is already ticket-authenticated by the route, only `input` and
 * `resize` messages are honoured, anything else is dropped without comment,
 * and detaching is unconditional on close so a closed tab never leaves a
 * subscriber behind.
 */
export function attachTerminal(
  socket: WebSocket,
  sessions: Services['sessions'],
  key: string,
): void {
  const send = (payload: unknown): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload))
  }
  let attached: { detach: () => void } | null = null
  try {
    const attachment = sessions.attach(
      key,
      (chunk) => send({ type: 'output', data: chunk }),
      (exitCode) => send({ type: 'exit', exitCode }),
    )
    attached = attachment
    send({ type: 'ready', session: attachment.view, backlog: attachment.backlog })
  } catch {
    socket.close(4404, 'no session')
    return
  }
  socket.on('message', (raw: Buffer) => {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    } catch {
      return
    }
    if (message.type === 'input' && typeof message.data === 'string') {
      try {
        sessions.write(key, message.data)
      } catch {
        send({ type: 'exit', exitCode: sessions.get(key)?.exitCode ?? 0 })
      }
      return
    }
    if (message.type === 'resize' && typeof message.cols === 'number' && typeof message.rows === 'number') {
      sessions.resize(key, Math.floor(message.cols), Math.floor(message.rows))
    }
  })
  socket.on('close', () => attached?.detach())
}
