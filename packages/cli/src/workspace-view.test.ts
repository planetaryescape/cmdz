import { expect, test } from 'bun:test'

import { createTestRenderer } from '@opentui/core/testing'
import { Effect } from 'effect'

import { runWorkspace } from './workspace-session'

test('starts, focuses, resizes, stops, and restarts one real command', async () => {
  const ui = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: false })
  const controller = new AbortController()
  const running = Effect.runPromiseExit(
    runWorkspace(ui.renderer, [
      {
        name: 'Demo',
        title: 'Demo',
        command: `bun run ${import.meta.dir}/demo-command.ts`,
        cwd: process.cwd(),
        env: {},
        autostart: false,
      },
    ]),
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
    await waitForText('Demo [idle]')
    ui.mockInput.pressEnter()
    await waitForText('cmdz demo')
    await waitForText('Demo [running]')
    ui.mockInput.pressEnter()
    await waitForText('INPUT')
    await ui.mockInput.typeText('hello')
    ui.mockInput.pressEnter()
    await waitForText('You typed: hello')
    ui.resize(100, 30)
    await waitForText('resized:78x28')
    await ui.mockInput.typeText('size')
    ui.mockInput.pressEnter()
    await waitForText('size:78x28')
    ui.mockInput.pressKey('z', { ctrl: true })
    await waitForText('NAVIGATION')
    ui.mockInput.pressKey('x')
    await waitForText('Demo [stopped]')
    ui.mockInput.pressKey('r')
    await waitForText('Demo [running]')
    await waitForText('cmdz demo')
    expect(ui.captureCharFrame()).not.toContain('You typed: hello')
    ui.mockInput.pressEnter()
    await waitForText('INPUT')
    await ui.mockInput.typeText('exit')
    ui.mockInput.pressEnter()
    await waitForText('Demo [succeeded]')
    ui.mockInput.pressKey('q')
    const exit = await running
    expect(exit._tag).toBe('Success')
  } finally {
    controller.abort()
    await running
    ui.renderer.destroy()
  }
}, 15000)
