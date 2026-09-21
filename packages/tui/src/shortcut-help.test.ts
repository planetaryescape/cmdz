import { expect, test } from 'bun:test'

import { createTestRenderer } from '@opentui/core/testing'

import { createShortcutHelp } from './shortcut-help'
import { workspaceTheme } from './theme'

test('creates a hidden shortcut overlay', async () => {
  const { renderer } = await createTestRenderer({ width: 80, height: 24 })
  try {
    const overlay = createShortcutHelp(renderer)
    expect(overlay.visible).toBe(false)
    expect(overlay.id).toBe('shortcut-help')
  } finally {
    renderer.destroy()
  }
})

test('refreshes help text when the terminal theme changes', async () => {
  const ui = await createTestRenderer({ width: 80, height: 24 })
  try {
    const overlay = createShortcutHelp(ui.renderer)
    ui.renderer.root.add(overlay)
    overlay.visible = true
    overlay.refresh(workspaceTheme('light'))
    await ui.renderOnce()

    const navigation = ui
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes('NAVIGATION'))
    expect(navigation?.fg.toInts().slice(0, 3)).toEqual([24, 33, 47])
  } finally {
    ui.renderer.destroy()
  }
})
