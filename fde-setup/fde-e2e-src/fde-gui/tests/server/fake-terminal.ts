import type { SpawnTerminal, SpawnTerminalOptions, TerminalProcess } from '../../server/src/services/sessions'

/**
 * A terminal that does exactly what a test tells it to. Nothing here starts a
 * process, so the whole session lifecycle is exercised without a real
 * `fde-start`, a real `claude`, or a real PTY.
 */
export class FakeTerminal implements TerminalProcess {
  static spawned: FakeTerminal[] = []

  readonly pid = Math.floor(Math.random() * 90000) + 1000
  readonly written: string[] = []
  readonly resizes: { cols: number; rows: number }[] = []
  readonly signals: string[] = []
  readonly options: SpawnTerminalOptions

  private data: ((chunk: string) => void)[] = []
  private exits: ((event: { exitCode: number }) => void)[] = []

  constructor(options: SpawnTerminalOptions) {
    this.options = options
  }

  onData(listener: (chunk: string) => void): void {
    this.data.push(listener)
  }
  onExit(listener: (event: { exitCode: number }) => void): void {
    this.exits.push(listener)
  }
  write(data: string): void {
    this.written.push(data)
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows })
  }
  kill(signal?: string): void {
    this.signals.push(signal ?? 'SIGTERM')
  }

  emit(chunk: string): void {
    for (const listener of this.data) listener(chunk)
  }
  finish(exitCode: number): void {
    for (const listener of this.exits) listener({ exitCode })
  }
}

export const fakeSpawn: SpawnTerminal = (options) => {
  const terminal = new FakeTerminal(options)
  FakeTerminal.spawned.push(terminal)
  return terminal
}
