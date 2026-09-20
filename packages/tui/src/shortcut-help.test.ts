import { expect, test } from 'bun:test'

import { createTestRenderer } from '@opentui/core/testing'

import { createShortcutHelp } from './shortcut-help'

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
