// @vitest-environment jsdom
import { createRef } from 'react'
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { instances } = vi.hoisted(() => ({ instances: [] as any[] }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>
    cols = 120
    rows = 32
    write = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    input: (data: string) => void = () => undefined
    constructor(options: Record<string, unknown>) { this.options = options; instances.push(this) }
    loadAddon() {}
    open() {}
    onData(listener: (data: string) => void) { this.input = listener; return { dispose: vi.fn() } }
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
import { TerminalView, type TerminalHandle } from '../../web/src/components/TerminalView'

afterEach(() => { instances.length = 0; vi.unstubAllGlobals() })

describe('terminal final screen (embedded resume contract)', () => {
  it('preserves startup output on exit and uses current input handlers on restart', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {} })
    const ref = createRef<TerminalHandle>()
    const oldInput = vi.fn()
    const newInput = vi.fn()
    const onResize = vi.fn()
    const view = render(<TerminalView ref={ref} onInput={oldInput} onResize={onResize} />)
    act(() => ref.current?.write('startup failed\r\n'))
    const term = instances[0]
    view.rerender(<TerminalView ref={ref} readOnly onInput={newInput} onResize={onResize} />)
    expect(instances).toHaveLength(1)
    expect(term.dispose).not.toHaveBeenCalled()
    expect(term.write).toHaveBeenCalledWith('startup failed\r\n')
    expect(term.options.disableStdin).toBe(true)
    term.input('ignored')
    expect(oldInput).not.toHaveBeenCalled()
    expect(newInput).not.toHaveBeenCalled()
    view.rerender(<TerminalView ref={ref} onInput={newInput} onResize={onResize} />)
    term.input('retry')
    expect(newInput).toHaveBeenCalledWith('retry')
    expect(term.options.disableStdin).toBe(false)
    view.unmount()
    expect(term.dispose).toHaveBeenCalledOnce()
  })
})
