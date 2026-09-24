import { expect, test } from 'bun:test'

import { makeRecordingProcessDriver } from '@cmdz/core/testing'
import {
  WorkspaceCommandError,
  WorkspaceShutdownError,
  createWorkspaceController,
} from '@cmdz/core/workspace'
import type { WorkspaceDefinition } from '@cmdz/core/workspace-definition'
import { renderWorkspaceView } from '@cmdz/tui/workspace-view'
import { createTestRenderer } from '@opentui/core/testing'
import { Cause, Effect, Exit } from 'effect'

test('surfaces failed cleanup and supports retry-only and retry-restart actions', async () => {
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
    await waitForText('RUNNING')
    driver.failCleanup('Demo', 1)
    ui.mockInput.pressKey('x')
    await waitForText('FAILED')
    const directory = process.env.CMDZ_E2E_EVIDENCE
    if (directory) await Bun.write(`${directory}/cleanup-failed.txt`, ui.captureCharFrame())

    ui.mockInput.pressKey('x')
    await waitForText('STOPPED')
    expect(driver.process('Demo', 1).cleanupAttempts).toBe(2)

    ui.mockInput.pressEnter()
    await waitForText('RUNNING')
    driver.failCleanup('Demo', 2)
    ui.mockInput.pressKey('x')
    await waitForText('FAILED')
    ui.mockInput.pressKey('r')
    await waitForText('RUNNING')
    expect(driver.process('Demo', 2).cleanupAttempts).toBe(2)
    expect(driver.process('Demo', 3).active).toBe(true)

    ui.mockInput.pressKey('q')
    expect((await running)._tag).toBe('Success')
  } finally {
    controller.abort()
    await running
    ui.renderer.destroy()
  }
}, 10000)

test('reports cleanup failure when initialization fails after starting a process', async () => {
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
  driver.failCleanup('Demo', 1, 2)

  try {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const controller = yield* createWorkspaceController([definition]).pipe(
          Effect.provide(driver.layer),
        )
        const failingController = {
          ...controller,
          initialize: (sizes: Parameters<typeof controller.initialize>[0]) =>
            controller
              .initialize(sizes)
              .pipe(
                Effect.andThen(
                  Effect.fail(new WorkspaceCommandError({ reason: 'workspaceAlreadyInitialized' })),
                ),
              ),
        }
        return yield* renderWorkspaceView(ui.renderer, [definition], failingController).pipe(
          Effect.exit,
        )
      }).pipe(Effect.scoped),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) throw new Error('Expected initialization to fail')
    const errors = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
    expect(errors.some((error) => error instanceof WorkspaceCommandError)).toBe(true)
    expect(errors.some((error) => error instanceof WorkspaceShutdownError)).toBe(true)
    expect(driver.process('Demo', 1).cleanupAttempts).toBe(1)
  } finally {
    ui.renderer.destroy()
  }
})
