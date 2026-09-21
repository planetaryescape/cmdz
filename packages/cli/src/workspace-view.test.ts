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
  const waitForMissingText = async (text: string) => {
    const deadline = performance.now() + 5000
    while (performance.now() < deadline) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      await ui.renderOnce()
      if (!ui.captureCharFrame().includes(text)) return
    }
    throw new Error(`Still found ${text}:\n${ui.captureCharFrame()}`)
  }
  const captureEvidence = async (name: string) => {
    const directory = process.env.CMDZ_E2E_EVIDENCE
    if (directory) await Bun.write(`${directory}/${name}.txt`, ui.captureCharFrame())
  }
  try {
    await waitForText('Enter start')
    expect(ui.captureCharFrame()).toContain('Demo · cmdz.ts')
    ui.mockInput.pressEnter()
    await waitForText('cmdz demo')
    await waitForText('RUNNING')
    expect(ui.captureCharFrame()).not.toContain('Enter start')
    ui.mockInput.pressEnter()
    await waitForText('INPUT')
    await ui.mockInput.typeText('hello')
    ui.mockInput.pressEnter()
    await waitForText('You typed: hello')
    ui.resize(100, 30)
    await waitForText('resized:71x26')
    await ui.mockInput.typeText('size')
    ui.mockInput.pressEnter()
    await waitForText('size:71x26')
    await captureEvidence('real-pty-running')
    ui.mockInput.pressKey('z', { ctrl: true })
    await waitForMissingText('INPUT')
    ui.mockInput.pressKey('x')
    await waitForText('STOPPED')
    ui.mockInput.pressKey('r')
    await waitForText('RUNNING')
    await waitForText('cmdz demo')
    expect(ui.captureCharFrame()).not.toContain('You typed: hello')
    ui.mockInput.pressEnter()
    await waitForText('INPUT')
    await ui.mockInput.typeText('exit')
    ui.mockInput.pressEnter()
    await waitForText('SUCCEEDED')
    await captureEvidence('real-pty-succeeded')
    ui.mockInput.pressKey('q')
    const exit = await running
    expect(exit._tag).toBe('Success')
  } finally {
    controller.abort()
    await running
    ui.renderer.destroy()
  }
}, 15000)
