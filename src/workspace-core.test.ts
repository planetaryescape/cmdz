import { expect, test } from 'bun:test'

import { Effect, Fiber, Stream } from 'effect'

import { makeWorkspaceCore } from './workspace-core'

const definitions = [
  { name: 'First', title: 'First', command: 'first', cwd: '/', env: {}, autostart: true },
  { name: 'Second', title: 'Second', command: 'second', cwd: '/', env: {}, autostart: false },
] as const

test('publishes immutable lifecycle snapshots and ignores stale process events', async () => {
  const snapshots = await Effect.runPromise(
    Effect.gen(function* () {
      const core = yield* makeWorkspaceCore(definitions)
      const updates = yield* core.snapshots.pipe(
        Stream.take(5),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* Effect.yieldNow
      yield* core.dispatch({ type: 'start', name: 'First' })
      yield* core.dispatch({ type: 'running', name: 'First', run: 1 })
      yield* core.dispatch({ type: 'exit', name: 'First', run: 0, code: 1 })
      yield* core.dispatch({ type: 'exit', name: 'First', run: 1, code: 0 })
      return yield* Fiber.join(updates)
    }).pipe(Effect.scoped),
  )

  const states = Array.from(snapshots)
  expect(states.map((snapshot) => snapshot.panes[0]?.status)).toEqual([
    'idle',
    'starting',
    'running',
    'running',
    'succeeded',
  ])
  expect(states[0]).not.toBe(states[1])
})
