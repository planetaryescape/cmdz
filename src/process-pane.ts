import { EmbeddedTerminalRenderable, type CliRenderer } from '@opentui/core'

import type { ProcessDefinition } from './config'

interface ProcessPaneHandlers {
  readonly onData: (
    name: string,
    run: number,
    bytes: Uint8Array,
    source: 'input' | 'response',
  ) => void
  readonly onResize: (name: string, columns: number, rows: number) => void
}

export class ProcessPane {
  terminal: EmbeddedTerminalRenderable
  run = 0

  constructor(
    readonly definition: ProcessDefinition,
    private readonly renderer: CliRenderer,
    readonly index: number,
    private readonly handlers: ProcessPaneHandlers,
  ) {
    this.terminal = this.makeTerminal()
  }

  reset(run: number) {
    this.terminal.destroy()
    this.run = run
    this.terminal = this.makeTerminal()
  }

  size() {
    const screen = this.terminal.screen()
    return { columns: Math.max(1, screen.columns), rows: Math.max(1, screen.rows) }
  }

  private makeTerminal() {
    const run = this.run
    return new EmbeddedTerminalRenderable(this.renderer, {
      id: `terminal-${this.index}-${this.run}`,
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      maxScrollback: 10000,
      selectable: false,
      onData: (bytes, source) => this.handlers.onData(this.definition.name, run, bytes, source),
      onTerminalResize: (columns, rows) =>
        this.handlers.onResize(this.definition.name, Math.max(1, columns), Math.max(1, rows)),
    })
  }
}
