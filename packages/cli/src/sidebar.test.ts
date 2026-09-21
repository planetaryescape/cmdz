import { expect, test } from 'bun:test'

import { createWorkspace, probe } from './testing/workspace'

test('sidebar visibility preserves selection and resizes foreground and background PTYs', async () => {
  const ui = await createWorkspace([probe, { ...probe, name: 'Other', title: 'Other' }])
  try {
    await ui.waitFor('PROBE_READY')
    await ui.mockMouse.click(5, 5)
    await ui.waitFor('Other [running]')
    await ui.waitFor('PROBE_READY')
    ui.mockInput.pressKey('h')
    await ui.waitFor('SIZE:100x28')
    expect(ui.captureCharFrame()).toContain('Other [running]')
    ui.mockInput.pressKey('k')
    await ui.waitFor('Probe [running]')
    await ui.waitFor('SIZE:100x28')
    ui.resize(120, 35)
    await ui.waitFor('SIZE:120x33')
    ui.mockInput.pressKey('h')
    await ui.waitFor('SIZE:98x33')
    ui.mockInput.pressKey('j')
    await ui.waitFor('Other [running]')
    await ui.waitFor('SIZE:98x33')
    ui.mockInput.pressEnter()
    ui.mockInput.pressKey('h')
    await ui.waitFor('RX:68')
    expect(ui.captureCharFrame()).toContain('SIZE:98x33')
  } finally {
    await ui.close()
  }
}, 15000)
