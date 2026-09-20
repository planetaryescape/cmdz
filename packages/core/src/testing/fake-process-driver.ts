import { Deferred, Effect, Layer, Semaphore } from 'effect'

import {
  ProcessCleanupError,
  ProcessDriver,
  type ProcessRun,
  ProcessRuntimeError,
  ProcessStartError,
  type ProcessStartRequest,
  type TerminalSize,
} from '../process-driver'

export interface RecordedProcessRun {
  readonly name: string
  readonly run: number
  readonly input: Uint8Array[]
  readonly sizes: TerminalSize[]
  readonly emit: (bytes: Uint8Array) => void
  readonly exit: (code: number) => Effect.Effect<boolean>
  readonly fail: (operation: string) => Effect.Effect<boolean>
  cleanupAttempts: number
  active: boolean
}

export interface RecordingGate {
  readonly reached: Effect.Effect<void>
  readonly release: Effect.Effect<void>
}

interface GateControl {
  readonly onReach: Effect.Effect<void>
  readonly awaitRelease: Effect.Effect<void>
}

export interface RecordingProcessDriver {
  readonly runs: Map<string, RecordedProcessRun>
  readonly startFailures: Set<string>
  readonly cleanupFailures: Map<string, number>

  readonly layer: Layer.Layer<ProcessDriver>
  readonly process: (name: string, run: number) => RecordedProcessRun
  readonly failCleanup: (name: string, run: number, attempts?: number) => void
  readonly gateStart: (name: string, run: number) => Effect.Effect<RecordingGate>
  readonly gateCleanup: (name: string, run: number) => Effect.Effect<RecordingGate>
}

export function makeRecordingProcessDriver(): RecordingProcessDriver {
  const runs = new Map<string, RecordedProcessRun>()
  const startFailures = new Set<string>()
  const cleanupFailures = new Map<string, number>()
  const startGates = new Map<string, GateControl>()
  const cleanupGates = new Map<string, GateControl>()
  const start = Effect.fn('process.driver.recording.start')(function* (
    request: ProcessStartRequest,
  ) {
    const key = runKey(request.name, request.run)
    const startGate = startGates.get(key)
    if (startGate) {
      yield* startGate.onReach
      yield* startGate.awaitRelease
      startGates.delete(key)
    }
    if (startFailures.has(request.name))
      return yield* Effect.fail(new ProcessStartError({ operation: 'spawn' }))
    if (runs.has(key)) throw new Error(`Duplicate fake process run: ${key}`)
    const exited = yield* Deferred.make<number, ProcessRuntimeError>()
    const cleanupLock = yield* Semaphore.make(1)
    let cleaned = false
    const recorded: RecordedProcessRun = {
      name: request.name,
      run: request.run,
      input: [],
      sizes: [request.size],
      cleanupAttempts: 0,
      active: true,
      emit: request.output,
      exit: (code) =>
        Effect.gen(function* () {
          recorded.active = false
          return yield* Deferred.succeed(exited, code)
        }),
      fail: (operation) =>
        Effect.gen(function* () {
          return yield* Deferred.fail(exited, new ProcessRuntimeError({ operation }))
        }),
    }
    const run: ProcessRun = {
      write: (bytes) =>
        Effect.sync(() => {
          recorded.input.push(bytes)
        }),
      resize: (size) =>
        Effect.sync(() => {
          recorded.sizes.push(size)
        }),
      awaitExit: Deferred.await(exited),
      cleanup: cleanupLock.withPermit(
        Effect.gen(function* () {
          if (cleaned) return
          const cleanupGate = cleanupGates.get(key)
          if (cleanupGate) {
            yield* cleanupGate.onReach.pipe(
              Effect.andThen(cleanupGate.awaitRelease),
              Effect.ensuring(Effect.sync(() => cleanupGates.delete(key))),
            )
          }
          recorded.cleanupAttempts++
          const failures = cleanupFailures.get(key) ?? 0
          if (failures > 0) {
            cleanupFailures.set(key, failures - 1)
            return yield* Effect.fail(
              new ProcessCleanupError({ operation: 'signal', processGroupId: request.run }),
            )
          }
          recorded.active = false
          cleaned = true
          yield* Deferred.succeed(exited, 0)
        }),
      ),
    }
    runs.set(key, recorded)
    return run
  })

  return {
    runs,
    startFailures,
    cleanupFailures,
    layer: Layer.succeed(ProcessDriver, ProcessDriver.of({ start })),
    process: (name, run) => {
      const process = runs.get(runKey(name, run))
      if (!process) throw new Error(`Unknown fake process run: ${name}:${run}`)
      return process
    },
    failCleanup: (name, run, attempts = 1) => {
      cleanupFailures.set(runKey(name, run), attempts)
    },
    gateStart: (name, run) => makeGate(startGates, runKey(name, run)),
    gateCleanup: (name, run) => makeGate(cleanupGates, runKey(name, run)),
  }
}

function runKey(name: string, run: number) {
  return `${name}:${run}`
}

const makeGate = (gates: Map<string, GateControl>, key: string) =>
  Effect.gen(function* () {
    if (gates.has(key)) throw new Error(`Duplicate fake process gate: ${key}`)
    const reached = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const gate: RecordingGate = {
      reached: Deferred.await(reached),
      release: Deferred.succeed(release, undefined).pipe(Effect.asVoid),
    }
    gates.set(key, {
      onReach: Deferred.succeed(reached, undefined).pipe(Effect.asVoid),
      awaitRelease: Deferred.await(release),
    })
    return gate
  })
