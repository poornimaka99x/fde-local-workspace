import { apiGet } from './api'

/**
 * Runs change from terminals too. The server watches its roots and keeps a
 * counter; this polls that counter and tells every open view to reload when it
 * moves. Where watching is unsupported the counter still moves after each
 * change the console makes, and each view keeps its own slower poll as a
 * backstop.
 */
type Listener = () => void

const listeners = new Set<Listener>()
let timer: number | null = null
let known: number | null = null

export function subscribeToChanges(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function announceChange(): void {
  for (const listener of [...listeners]) listener()
}

export function startChangePolling(intervalMs = 3000): () => void {
  const tick = async (): Promise<void> => {
    try {
      const state = await apiGet<{ version: number }>('/api/state-version')
      if (known !== null && state.version !== known) announceChange()
      known = state.version
    } catch {
      // A blip is not worth a banner; the next tick tries again.
    }
  }
  void tick()
  timer = window.setInterval(() => void tick(), intervalMs)
  return () => {
    if (timer !== null) window.clearInterval(timer)
    timer = null
  }
}
