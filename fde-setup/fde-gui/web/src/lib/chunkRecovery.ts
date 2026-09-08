const RECOVERY_KEY = 'fde-gui-chunk-recovery-entry'

function entryScript(target: Window): string {
  const script = target.document.querySelector<HTMLScriptElement>('script[type="module"][src]')
  return script?.src || target.location.pathname
}

/**
 * Vite raises this event when an open page asks for a lazy chunk that a newer
 * build replaced. Refresh once for each entry bundle so the browser loads the
 * new chunk map, while a genuinely broken build cannot create a reload loop.
 */
export function installChunkRecovery(
  target: Window = window,
  reload: () => void = () => target.location.reload(),
): () => void {
  const handler = (event: Event): void => {
    event.preventDefault()
    const entry = entryScript(target)
    if (target.sessionStorage.getItem(RECOVERY_KEY) === entry) return
    target.sessionStorage.setItem(RECOVERY_KEY, entry)
    reload()
  }
  target.addEventListener('vite:preloadError', handler)
  return () => target.removeEventListener('vite:preloadError', handler)
}
