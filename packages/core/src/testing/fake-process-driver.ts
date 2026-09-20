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

export interface RecordingProcessDriver {
  readonly runs: Map<string, RecordedProcessRun>
  readonly startFailures: Set<string>
  readonly cleanupFailures: Map<string, number>

  readonly layer: Layer.Layer<ProcessDriver>
  readonly process: (name: string, run: number) => RecordedProcessRun
  readonly failCleanup: (name: string, run: number, attempts?: number) => void
}

export function makeRecordingProcessDriver(): RecordingProcessDriver {
  const runs = new Map<string, RecordedProcessRun>()
  const startFailures = new Set<string>()
  const cleanupFailures = new Map<string, number>()
  const start = Effect.fn('process.driver.recording.start')(function* (
    request: ProcessStartRequest,
  ) {
    if (startFailures.has(request.name))
      return yield* Effect.fail(new ProcessStartError({ operation: 'spawn' }))
    const key = runKey(request.name, request.run)
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
        Effect.suspend(() => {
          if (cleaned) return Effect.void
          recorded.cleanupAttempts++
          const failures = cleanupFailures.get(key) ?? 0
          if (failures > 0) {
            cleanupFailures.set(key, failures - 1)
            return Effect.fail(
              new ProcessCleanupError({ operation: 'signal', processGroupId: request.run }),
            )
          }
          recorded.active = false
          cleaned = true
          return Deferred.succeed(exited, 0).pipe(Effect.asVoid)
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
  }
}

function runKey(name: string, run: number) {
  return `${name}:${run}`
}
