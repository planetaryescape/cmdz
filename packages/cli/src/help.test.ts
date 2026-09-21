import { expect, test } from 'bun:test'

import { createWorkspace, probe } from './testing/workspace'

test('help consumes keys, paste, and mouse input until dismissed', async () => {
  const ui = await createWorkspace([probe])
  try {
    await ui.waitFor('PROBE_READY')
    ui.mockInput.pressKey('?')
    await ui.waitFor('cmdz shortcuts')
    await ui.mockMouse.click(30, 3)
    await ui.mockInput.pasteBracketedText('DROP')
    await ui.mockInput.typeText('xrhq')
    ui.mockInput.pressEnter()
    await ui.waitFor('cmdz shortcuts')
    ui.mockInput.pressEscape()
    await ui.waitFor('Probe · cmdz.ts')
    expect(ui.captureCharFrame()).not.toContain('cmdz shortcuts')
    expect(ui.captureCharFrame()).toContain('Probe · cmdz.ts')
    ui.mockInput.pressEnter()
    await ui.mockInput.typeText('?')
    await ui.waitFor('RX:3f')
    expect(ui.captureCharFrame()).not.toContain('cmdz shortcuts')
    ui.mockInput.pressKey('z', { ctrl: true })
    ui.mockInput.pressKey('?')
    await ui.waitFor('cmdz shortcuts')
    ui.mockInput.pressKey('?')
    await ui.waitFor('Probe · cmdz.ts')
    expect(ui.captureCharFrame()).not.toContain('cmdz shortcuts')
  } finally {
    await ui.close()
  }
}, 15000)
