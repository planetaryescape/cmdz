import { bold, BoxRenderable, fg, t, TextRenderable, type CliRenderer } from '@opentui/core'

import { workspaceTheme, type WorkspaceTheme } from './theme'

const wideHelp = [
  'cmdz shortcuts                                      Esc close',
  '',
  'NAVIGATION',
  'j/k or Up/Down   Select command',
  'Enter            Start or focus command',
  'h                Hide/show commands',
  'x                Stop command',
  'r                Restart command',
  'q / Ctrl-C       Quit cmdz',
  '?                Show shortcut help',
  '',
  'INPUT',
  'Ctrl-Z           Return to navigation',
  'Ctrl-C           Interrupt child',
  'Other keys and paste go to the child.',
].join('\n')

export class ShortcutHelp extends BoxRenderable {
  private readonly panel: BoxRenderable
  private readonly text: TextRenderable

  constructor(
    private readonly renderer: CliRenderer,
    theme: WorkspaceTheme,
  ) {
    super(renderer, {
      id: 'shortcut-help',
      position: 'absolute',
      width: '100%',
      height: '100%',
      zIndex: 10,
      visible: false,
      backgroundColor: theme.canvas,
      justifyContent: 'center',
      alignItems: 'center',
      onMouse: (event) => {
        event.preventDefault()
        event.stopPropagation()
      },
    })
    this.panel = new BoxRenderable(renderer, {
      id: 'shortcut-help-panel',
      padding: 1,
      border: true,
      borderColor: theme.border,
      backgroundColor: theme.surface,
    })
    this.text = new TextRenderable(renderer, {
      id: 'shortcut-help-text',
      fg: theme.text,
      truncate: true,
    })
    this.panel.add(this.text)
    this.add(this.panel)
    this.refresh(theme)
  }

  refresh(theme: WorkspaceTheme) {
    const compact = this.renderer.terminalWidth < 72 || this.renderer.terminalHeight < 22
    this.backgroundColor = theme.canvas
    this.panel.backgroundColor = theme.surface
    this.panel.borderColor = theme.border
    this.text.fg = theme.text
    this.panel.width = compact ? '100%' : 68
    this.panel.height = compact ? Math.min(14, this.renderer.terminalHeight) : 19
    this.text.content = compact
      ? t`${bold(fg(theme.accent)('cmdz shortcuts'))}${fg(theme.muted)('        Esc close')}\n\n${bold('NAVIGATION')}\n↑/↓ select   Enter open\nh commands  x stop\nr restart   q quit   ? help\n\n${bold('INPUT')}\nCtrl-Z navigate\nCtrl-C interrupt child`
      : t`${bold(fg(theme.accent)('cmdz shortcuts'))}${fg(theme.muted)('                                      Esc close')}\n\n${bold('NAVIGATION')}\n${wideHelp.split('\n').slice(3).join('\n')}`
  }
}

export function createShortcutHelp(
  renderer: CliRenderer,
  theme = workspaceTheme(renderer.themeMode),
) {
  return new ShortcutHelp(renderer, theme)
}
