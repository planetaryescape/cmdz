import { expect, test } from 'bun:test'

import { createWorkspaceController } from '@cmdz/core/workspace'
import type { WorkspaceDefinition } from '@cmdz/core/workspace-definition'
import { renderWorkspaceView } from '@cmdz/tui/workspace-view'
import { createTestRenderer } from '@opentui/core/testing'
import { Effect } from 'effect'

import { makeRecordingProcessDriver } from '../../core/src/testing/fake-process-driver'

test('surfaces failed cleanup and lets the user retry it', async () => {
  const ui = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: false })
  const driver = makeRecordingProcessDriver()
  const definition: WorkspaceDefinition = {
    name: 'Demo',
    title: 'Demo',
    command: 'demo',
    cwd: '/',
    env: {},
    autostart: true,
  }
  const controller = new AbortController()
  const running = Effect.runPromiseExit(
    Effect.gen(function* () {
      const workspace = yield* createWorkspaceController([definition]).pipe(
        Effect.provide(driver.layer),
      )
      yield* renderWorkspaceView(ui.renderer, [definition], workspace)
    }).pipe(Effect.scoped),
    { signal: controller.signal },
  )
  const waitForText = async (text: string) => {
    const deadline = performance.now() + 5000
    while (performance.now() < deadline) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      await ui.renderOnce()
      if (ui.captureCharFrame().includes(text)) return
    }
    throw new Error(`Missing ${text}:\n${ui.captureCharFrame()}`)
  }

  try {
    await waitForText('Demo [running]')
    driver.failCleanup('Demo', 1)
    ui.mockInput.pressKey('x')
    await waitForText('Demo [cleanup failed]')
    await waitForText('x retry only | r retry + restart')
    const directory = process.env.CMDZ_E2E_EVIDENCE
    if (directory) await Bun.write(`${directory}/cleanup-failed.txt`, ui.captureCharFrame())

    ui.mockInput.pressKey('x')
    await waitForText('Demo [stopped]')
    expect(driver.process('Demo', 1).cleanupAttempts).toBe(2)
    ui.mockInput.pressKey('q')
    expect((await running)._tag).toBe('Success')
  } finally {
    controller.abort()
    await running
    ui.renderer.destroy()
  }
}, 10000)
