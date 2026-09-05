import { expect, test } from 'bun:test'

import { createTestRenderer } from '@opentui/core/testing'
import { Effect } from 'effect'

import { processWorkspace } from './process-workspace'

test('autostarts configured commands and isolates optional panes and input', async () => {
  const ui = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: false })
  const controller = new AbortController()
  const running = Effect.runPromiseExit(
    processWorkspace(ui.renderer, [
      {
        name: 'First',
        title: 'First',
        command: 'printf "FIRST_READY\\n"; read value; printf "FIRST:%s\\n" "$value"; read final',
        cwd: process.cwd(),
        env: {},
        autostart: true,
      },
      {
        name: 'Second',
        title: 'Second',
        command: 'printf "SECOND_READY\\n"; read value; printf "SECOND:%s\\n" "$value"; read final',
        cwd: process.cwd(),
        env: {},
        autostart: false,
      },
    ]),
    { signal: controller.signal },
  )
  const wait = async (text: string) => {
    const deadline = performance.now() + 5000
    while (performance.now() < deadline) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      await ui.renderOnce()
      if (ui.captureCharFrame().includes(text)) return
    }
    throw new Error(`Missing ${text}:\n${ui.captureCharFrame()}`)
  }
  try {
    await wait('FIRST_READY')
    ui.mockInput.pressKey('j')
    await wait('Second [idle]')
    expect(ui.captureCharFrame()).not.toContain('FIRST_READY')
    ui.mockInput.pressEnter()
    await wait('SECOND_READY')
    ui.mockInput.pressEnter()
    await wait('INPUT')
    await ui.mockInput.typeText('hello')
    ui.mockInput.pressEnter()
    await wait('SECOND:hello')
    ui.mockInput.pressKey('z', { ctrl: true })
    ui.mockInput.pressKey('k')
    await wait('First [running]')
    expect(ui.captureCharFrame()).toContain('FIRST_READY')
    expect(ui.captureCharFrame()).not.toContain('SECOND:hello')
    ui.mockInput.pressKey('x')
    await wait('First [stopped]')
    const rows = ui.captureCharFrame().split('\n').slice(1)
    const secondRow = rows.findIndex((line) => line.trimStart().startsWith('Second'))
    const firstRow = rows.findIndex((line) => line.trimStart().startsWith('> First'))
    expect(secondRow).toBeGreaterThanOrEqual(0)
    expect(firstRow).toBeGreaterThan(secondRow)
    ui.mockInput.pressKey('q')
    expect((await running)._tag).toBe('Success')
  } finally {
    controller.abort()
    await running
    ui.renderer.destroy()
  }
}, 15000)
