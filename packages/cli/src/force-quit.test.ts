import { expect, test } from 'bun:test'

import { createWorkspace, probe } from './testing/workspace'

test('a second Ctrl-C force-quits a child that ignores SIGTERM', async () => {
  const ui = await createWorkspace([
    {
      ...probe,
      command: `${process.execPath} -e 'process.on("SIGTERM", () => console.log("TERM_RECEIVED")); console.log("READY"); await new Promise(() => {});'`,
    },
  ])
  try {
    await ui.waitFor('READY')
    ui.mockInput.pressKey('q')
    await ui.waitFor('TERM_RECEIVED')
    ui.mockInput.pressCtrlC()
    expect((await ui.running)._tag).toBe('Success')
  } finally {
    ui.mockInput.pressCtrlC()
    await ui.close()
  }
}, 8000)
