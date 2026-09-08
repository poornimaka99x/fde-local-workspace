// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installChunkRecovery } from '../../web/src/lib/chunkRecovery'

describe('lazy chunk recovery', () => {
  afterEach(() => window.sessionStorage.clear())

  it('refreshes once when an open page references a replaced Vite chunk', () => {
    const reload = vi.fn()
    const uninstall = installChunkRecovery(window, reload)
    const first = new Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(first)
    const second = new Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(second)
    uninstall()

    expect(first.defaultPrevented).toBe(true)
    expect(second.defaultPrevented).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
