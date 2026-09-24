import { normalizeTerminalSize } from '@cmdz/core/process-driver'
import type { WorkspaceDefinition } from '@cmdz/core/workspace-definition'
import {
  EmbeddedTerminalRenderable,
  RGBA,
  type CliRenderer,
  type OptimizedBuffer,
} from '@opentui/core'

import type { WorkspaceTheme } from './theme'

const black = RGBA.fromHex('#000000')
const white = RGBA.fromHex('#ffffff')

function recolorTerminalDefaults(buffer: OptimizedBuffer, theme: WorkspaceTheme) {
  const background = RGBA.fromHex(theme.canvas)
  const foreground = RGBA.fromHex(theme.text)
  for (const [y, line] of buffer.getSpanLines().entries()) {
    let x = 0
    for (const span of line.spans) {
      if (span.bg.equals(black))
        buffer.drawText(
          span.text,
          x,
          y,
          span.fg.equals(white) ? foreground : span.fg,
          background,
          span.attributes,
        )
      x += span.width
    }
  }
}

interface ProcessPaneHandlers {
  readonly onData: (
    name: string,
    run: number,
    bytes: Uint8Array,
    source: 'input' | 'response',
  ) => void
  readonly onResize: (name: string, columns: number, rows: number) => void
}

export class TerminalPane {
  terminal: EmbeddedTerminalRenderable
  run = 0

  constructor(
    readonly definition: WorkspaceDefinition,
    private readonly renderer: CliRenderer,
    readonly index: number,
    private readonly handlers: ProcessPaneHandlers,
    private theme: WorkspaceTheme,
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
    return normalizeTerminalSize(screen.columns, screen.rows)
  }

  setTheme(theme: WorkspaceTheme) {
    this.theme = theme
    this.terminal.invalidate()
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
      renderAfter: (buffer) => recolorTerminalDefaults(buffer, this.theme),
      onData: (bytes, source) => this.handlers.onData(this.definition.name, run, bytes, source),
      onTerminalResize: (columns, rows) =>
        this.handlers.onResize(this.definition.name, Math.max(1, columns), Math.max(1, rows)),
    })
  }
}
