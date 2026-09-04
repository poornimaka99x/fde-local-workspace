import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export interface TerminalHandle {
  write: (data: string) => void
  focus: () => void
}

/**
 * The screen for one `fde-start --resume` process. It renders bytes and sends
 * keystrokes; it knows nothing about runs, tickets or the controller.
 */
export const TerminalView = forwardRef<
  TerminalHandle,
  {
    onInput: (data: string) => void
    onResize: (cols: number, rows: number) => void
    readOnly?: boolean
    ariaLabel?: string
  }
>(function TerminalView({ onInput, onResize, readOnly = false, ariaLabel = 'Orchestrator session terminal' }, ref) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)

  useImperativeHandle(ref, () => ({
    write: (data: string) => terminal.current?.write(data),
    focus: () => terminal.current?.focus(),
  }))

  useEffect(() => {
    if (host.current === null) return
    const term = new Terminal({
      convertEol: true,
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: { background: '#0f1218', foreground: '#e8ecf2' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    terminal.current = term

    const resize = (): void => {
      try {
        fit.fit()
        onResize(term.cols, term.rows)
      } catch {
        /* the pane can be measured before it is laid out */
      }
    }
    resize()

    const typed = term.onData((data) => {
      if (!readOnly) onInput(data)
    })
    const observer = new ResizeObserver(resize)
    observer.observe(host.current)

    return () => {
      observer.disconnect()
      typed.dispose()
      term.dispose()
      terminal.current = null
    }
    // The callbacks are stable for the life of a session panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly])

  return (
    <div
      ref={host}
      role="group"
      aria-label={ariaLabel}
      style={{
        height: '60vh',
        minHeight: 320,
        padding: 8,
        background: '#0f1218',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
      }}
    />
  )
})
