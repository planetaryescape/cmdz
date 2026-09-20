import { expect, test } from 'bun:test'

import { Effect, Fiber, Stream } from 'effect'

import type { ProcessDefinition } from './config'
import { makeRecordingProcessDriver } from './testing/fake-process-driver'
import {
  createWorkspaceController,
  type PaneSnapshot,
  WorkspaceShutdownError,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
} from './workspace-core'

const definition = (name: string, autostart = false): ProcessDefinition => ({
  name,
  title: name,
  command: name.toLowerCase(),
  cwd: '/',
  env: {},
  autostart,
})

const size = { columns: 80, rows: 24 }

function pane(snapshot: WorkspaceSnapshot, name: string): PaneSnapshot {
  const found = snapshot.panes.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`Unknown pane: ${name}`)
  return found
}

function runOf(snapshot: WorkspaceSnapshot, name: string) {
  const lifecycle = pane(snapshot, name).lifecycle
  return lifecycle._tag === 'Idle' ? lifecycle.lastRun : lifecycle.run
}

test('drives typed lifecycle, opaque output, input, and resize through one controller', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = makeRecordingProcessDriver()
      const controller = yield* createWorkspaceController([definition('Web')]).pipe(
        Effect.provide(driver.layer),
      )
      const events = yield* controller.events.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* Effect.yieldNow
      yield* controller.initialize({ Web: size })
      const running = yield* controller.dispatch({ type: 'start', name: 'Web', size })
      const process = driver.process('Web', runOf(running, 'Web'))
      const output = new Uint8Array([0x1b, 0x5b, 0x32, 0x4a])
      process.emit(output)
      yield* controller.dispatch({ type: 'enterInput', name: 'Web' })
      const input = new TextEncoder().encode('reload\n')
      yield* controller.dispatch({ type: 'write', name: 'Web', source: 'user', bytes: input })
      yield* controller.dispatch({
        type: 'resize',
        name: 'Web',
        size: { columns: 132, rows: 43 },
      })
      yield* process.exit(0)
      yield* Effect.yieldNow
      return {
        events: Array.from(yield* Fiber.join(events)),
        input,
        output,
        process,
        snapshot: yield* controller.snapshot,
      }
    }).pipe(Effect.scoped),
  )

  expect(result.events.map((event: WorkspaceEvent) => event.type)).toEqual([
    'resetTerminal',
    'output',
  ])
  expect(result.events[1]).toEqual({ type: 'output', name: 'Web', run: 1, bytes: result.output })
  expect(result.process.input).toEqual([result.input])
  expect(result.process.sizes.at(-1)).toEqual({ columns: 132, rows: 43 })
  expect(pane(result.snapshot, 'Web').lifecycle).toEqual({
    _tag: 'Succeeded',
    run: 1,
    exitCode: 0,
  })
  expect(result.snapshot.mode).toBe('navigation')
})

test('routes terminal responses to a background run but rejects background user input', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = makeRecordingProcessDriver()
      const controller = yield* createWorkspaceController([
        definition('Web', true),
        definition('Worker', true),
      ]).pipe(Effect.provide(driver.layer))
      yield* controller.initialize({ Web: size, Worker: size })
      yield* controller.dispatch({ type: 'select', name: 'Worker' })
      yield* controller.dispatch({ type: 'enterInput', name: 'Worker' })
      const response = new TextEncoder().encode('terminal-response')
      yield* controller.dispatch({
        type: 'write',
        name: 'Web',
        source: 'terminalResponse',
        bytes: response,
        run: 1,
      })
      const rejected = yield* Effect.exit(
        controller.dispatch({ type: 'write', name: 'Web', source: 'user', bytes: response }),
      )
      return { driver, rejected, response }
    }).pipe(Effect.scoped),
  )

  expect(result.driver.process('Web', 1).input).toEqual([result.response])
  expect(result.rejected._tag).toBe('Failure')
})

test('waits for cleanup before restart and rejects output from the previous run', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = makeRecordingProcessDriver()
      const controller = yield* createWorkspaceController([definition('Web')]).pipe(
        Effect.provide(driver.layer),
      )
      const events = yield* controller.events.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* Effect.yieldNow
      yield* controller.initialize({ Web: size })
      const firstSnapshot = yield* controller.dispatch({ type: 'start', name: 'Web', size })
      const first = driver.process('Web', runOf(firstSnapshot, 'Web'))
      const restarted = yield* controller.dispatch({ type: 'restart', name: 'Web', size })
      const second = driver.process('Web', runOf(restarted, 'Web'))
      first.emit(new TextEncoder().encode('stale'))
      const staleResponse = yield* Effect.exit(
        controller.dispatch({
          type: 'write',
          name: 'Web',
          source: 'terminalResponse',
          run: first.run,
          bytes: new TextEncoder().encode('stale-response'),
        }),
      )
      const fresh = new TextEncoder().encode('fresh')
      second.emit(fresh)
      return {
        events: Array.from(yield* Fiber.join(events)),
        first,
        fresh,
        second,
        snapshot: yield* controller.snapshot,
        staleResponse,
      }
    }).pipe(Effect.scoped),
  )

  expect(result.first.cleanupAttempts).toBe(1)
  expect(result.first.active).toBe(false)
  expect(result.second.run).toBe(result.first.run + 1)
  expect(result.staleResponse._tag).toBe('Failure')
  expect(result.second.input).toEqual([])
  expect(result.events.filter((event) => event.type === 'output')).toEqual([
    { type: 'output', name: 'Web', run: 2, bytes: result.fresh },
  ])
  expect(pane(result.snapshot, 'Web').lifecycle._tag).toBe('Running')
})

test('rejects duplicate start without replacing the current run', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = makeRecordingProcessDriver()
      const controller = yield* createWorkspaceController([definition('Web')]).pipe(
        Effect.provide(driver.layer),
      )
      yield* controller.initialize({ Web: size })
      yield* controller.dispatch({ type: 'start', name: 'Web', size })
      const duplicate = yield* Effect.exit(
        controller.dispatch({ type: 'start', name: 'Web', size }),
      )
      return { active: driver.process('Web', 1).active, driver, duplicate }
    }).pipe(Effect.scoped),
  )

  expect(result.duplicate._tag).toBe('Failure')
  expect(result.driver.runs.size).toBe(1)
  expect(result.active).toBe(true)
})

test('classifies start, runtime, nonzero exit, manual stop, and unresolved cleanup', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = makeRecordingProcessDriver()
      driver.startFailures.add('Start')
      const controller = yield* createWorkspaceController([
        definition('Start'),
        definition('Runtime'),
        definition('Exit'),
        definition('Stop'),
        definition('Cleanup'),
      ]).pipe(Effect.provide(driver.layer))
      yield* controller.initialize({
        Start: size,
        Runtime: size,
        Exit: size,
        Stop: size,
        Cleanup: size,
      })
      yield* controller.dispatch({ type: 'start', name: 'Start', size })
      yield* controller.dispatch({ type: 'start', name: 'Runtime', size })
      yield* driver.process('Runtime', 1).fail('read')
      yield* Effect.yieldNow
      yield* controller.dispatch({ type: 'start', name: 'Exit', size })
      yield* driver.process('Exit', 1).exit(17)
      yield* Effect.yieldNow
      yield* controller.dispatch({ type: 'start', name: 'Stop', size })
      yield* controller.dispatch({ type: 'stop', name: 'Stop' })
      yield* controller.dispatch({ type: 'start', name: 'Cleanup', size })
      driver.failCleanup('Cleanup', 1)
      yield* controller.dispatch({ type: 'stop', name: 'Cleanup' })
      const restart = yield* Effect.exit(
        controller.dispatch({ type: 'restart', name: 'Cleanup', size }),
      )
      return { restart, snapshot: yield* controller.snapshot }
    }).pipe(Effect.scoped),
  )

  expect(pane(result.snapshot, 'Start').lifecycle).toMatchObject({
    _tag: 'Failed',
    failure: { _tag: 'StartFailed', operation: 'spawn' },
  })
  expect(pane(result.snapshot, 'Runtime').lifecycle).toMatchObject({
    _tag: 'Failed',
    failure: { _tag: 'RuntimeFailed', operation: 'read' },
  })
  expect(pane(result.snapshot, 'Exit').lifecycle).toMatchObject({
    _tag: 'Failed',
    failure: { _tag: 'Exited', exitCode: 17 },
  })
  expect(pane(result.snapshot, 'Stop').lifecycle._tag).toBe('Stopped')
  expect(pane(result.snapshot, 'Cleanup').lifecycle).toMatchObject({
    _tag: 'Failed',
    failure: { _tag: 'CleanupFailed', processGroupId: 1 },
  })
  expect(result.restart._tag).toBe('Failure')
})

test('initializes autostart once, keeps optional panes idle, and resizes every active pane', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = makeRecordingProcessDriver()
      const controller = yield* createWorkspaceController([
        definition('Web', true),
        definition('Worker', true),
        definition('Optional'),
      ]).pipe(Effect.provide(driver.layer))
      const initialized = yield* controller.initialize({ Web: size, Worker: size, Optional: size })
      yield* controller.dispatch({
        type: 'resize',
        name: 'Web',
        size: { columns: 100, rows: 30 },
      })
      yield* controller.dispatch({
        type: 'resize',
        name: 'Worker',
        size: { columns: 78, rows: 20 },
      })
      const duplicate = yield* Effect.exit(
        controller.initialize({ Web: size, Worker: size, Optional: size }),
      )
      return { driver, duplicate, initialized }
    }).pipe(Effect.scoped),
  )

  expect(pane(result.initialized, 'Optional').lifecycle).toEqual({ _tag: 'Idle', lastRun: 0 })
  expect(result.driver.process('Web', 1).sizes.at(-1)).toEqual({ columns: 100, rows: 30 })
  expect(result.driver.process('Worker', 1).sizes.at(-1)).toEqual({ columns: 78, rows: 20 })
  expect(result.driver.runs.has('Optional:1')).toBe(false)
  expect(result.duplicate._tag).toBe('Failure')
})

test('retries failed pane cleanup during shutdown and still cleans every peer', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = makeRecordingProcessDriver()
      const controller = yield* createWorkspaceController([
        definition('Web', true),
        definition('Worker', true),
        definition('Optional'),
      ]).pipe(Effect.provide(driver.layer))
      yield* controller.initialize({ Web: size, Worker: size, Optional: size })
      driver.failCleanup('Web', 1)
      const stopped = yield* controller.dispatch({ type: 'stop', name: 'Web' })
      yield* controller.shutdown
      return { driver, snapshot: yield* controller.snapshot, stopped }
    }).pipe(Effect.scoped),
  )

  expect(pane(result.stopped, 'Web').lifecycle._tag).toBe('Failed')
  expect(result.driver.process('Web', 1).cleanupAttempts).toBe(2)
  expect(result.driver.process('Worker', 1).cleanupAttempts).toBe(1)
  expect(result.driver.runs.has('Optional:1')).toBe(false)
  expect(result.snapshot.shuttingDown).toBe(true)
  expect(pane(result.snapshot, 'Web').lifecycle._tag).toBe('Stopped')
  expect(Array.from(result.driver.runs.values()).every((process) => !process.active)).toBe(true)
})

test('aggregates unresolved cleanup after attempting every pane and memoizes shutdown', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = makeRecordingProcessDriver()
      const controller = yield* createWorkspaceController([
        definition('Web', true),
        definition('Worker', true),
      ]).pipe(Effect.provide(driver.layer))
      yield* controller.initialize({ Web: size, Worker: size })
      driver.failCleanup('Web', 1, 3)
      yield* driver.process('Web', 1).exit(23)
      yield* Effect.yieldNow
      const first = yield* Effect.flip(controller.shutdown)
      const second = yield* Effect.flip(controller.shutdown)
      return { driver, first, second }
    }).pipe(Effect.scoped),
  )

  expect(result.first).toBeInstanceOf(WorkspaceShutdownError)
  expect(result.first.failures).toEqual([
    { name: 'Web', run: 1, operation: 'signal', processGroupId: 1, priorExitCode: 23 },
  ])
  expect(result.second).toBe(result.first)
  expect(result.driver.process('Web', 1).cleanupAttempts).toBe(2)
  expect(result.driver.process('Worker', 1).cleanupAttempts).toBe(1)
  expect(result.driver.process('Worker', 1).active).toBe(false)
})
