import { expect, test } from 'bun:test'

import { createWorkspace, probe } from './testing/workspace'

test('compact layouts hide the sidebar and keep the terminal and help visible', async () => {
  const ui = await createWorkspace([
    { ...probe, title: 'Web application development server' },
    {
      ...probe,
      name: 'Component explorer',
      title: 'Component explorer',
      autostart: false,
    },
  ])
  try {
    await ui.waitFor('PROBE_READY')
    ui.resize(60, 18)
    await ui.waitFor('SIZE:58x14')
    const medium = ui.captureCharFrame()
    expect(medium).not.toContain('RUNNING')
    expect(medium).toContain('Web application')

    ui.resize(40, 14)
    await ui.waitFor('SIZE:38x10')
    ui.mockInput.pressKey('?')
    await ui.waitFor('Esc close')
    const help = ui.captureCharFrame()
    expect(help).toContain('NAVIGATION')
    expect(help).toContain('Ctrl-Z navigate')
    expect(help).toContain('Ctrl-C interrupt child')
  } finally {
    await ui.close()
  }
})
