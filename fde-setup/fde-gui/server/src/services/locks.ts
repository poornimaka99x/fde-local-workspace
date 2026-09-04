/**
 * A per-key advisory lock, held only for the length of one request.
 *
 * The controller is the only writer, and it is safe to run twice — but two
 * GUI-triggered mutations racing on one run produce a confusing screen and a
 * pointless second refusal. So a second mutation on a busy run is told the run
 * is busy, rather than queued behind an operation whose outcome it cannot see.
 */
export class AdvisoryLocks {
  private readonly held = new Set<string>()

  tryAcquire(key: string): (() => void) | null {
    if (this.held.has(key)) return null
    this.held.add(key)
    let released = false
    return () => {
      if (released) return
      released = true
      this.held.delete(key)
    }
  }

  isHeld(key: string): boolean {
    return this.held.has(key)
  }
}
