/**
 * The per-launch token arrives in the URL fragment, which the browser never
 * sends to a server. We take it, wipe it from the address bar, and keep it in
 * this tab's sessionStorage so a reload still works.
 */
const KEY = 'fde-gui-token'

export function captureToken(): string | null {
  try {
    const hash = window.location.hash
    const match = /(?:^#|&)token=([A-Za-z0-9._~-]+)/.exec(hash)
    if (match?.[1]) {
      window.sessionStorage.setItem(KEY, match[1])
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      return match[1]
    }
    return window.sessionStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function currentToken(): string | null {
  try {
    return window.sessionStorage.getItem(KEY)
  } catch {
    return null
  }
}
