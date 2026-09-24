import { expect, test } from 'bun:test'

import { createWorkspace, probe } from './testing/workspace'

test('sidebar visibility preserves selection and resizes foreground and background PTYs', async () => {
  const ui = await createWorkspace([probe, { ...probe, name: 'Other', title: 'Other' }])
  try {
    await ui.waitFor('PROBE_READY')
    await ui.mockMouse.click(5, 6)
    await ui.waitFor('Other · cmdz.ts')
    await ui.waitFor('PROBE_READY')
    ui.mockInput.pressKey('h')
    await ui.waitFor('SIZE:98x26')
    expect(ui.captureCharFrame()).toContain('Other · cmdz.ts')
    ui.mockInput.pressKey('k')
    await ui.waitFor('Probe · cmdz.ts')
    await ui.waitFor('SIZE:98x26')
    ui.resize(120, 35)
    await ui.waitFor('SIZE:118x31')
    ui.mockInput.pressKey('h')
    await ui.waitFor('SIZE:91x31')
    ui.mockInput.pressKey('j')
    await ui.waitFor('Other · cmdz.ts')
    await ui.waitFor('SIZE:91x31')
    ui.mockInput.pressEnter()
    ui.mockInput.pressKey('h')
    await ui.waitFor('RX:68')
    expect(ui.captureCharFrame()).toContain('SIZE:91x31')
  } finally {
    await ui.close()
  }
}, 15000)
