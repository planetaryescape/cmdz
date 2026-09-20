import { Effect, Layer, Option, Result, Semaphore } from 'effect'

import {
  ProcessCleanupError,
  ProcessDriver,
  ProcessIoError,
  type ProcessRun,
  ProcessRuntimeError,
  ProcessStartError,
  type ProcessStartRequest,
} from './process-driver'

interface TerminalPort {
  readonly columns: number
  readonly rows: number
  readonly output: (bytes: Uint8Array) => void
  readonly attach: (terminal: Bun.Terminal | undefined) => void
}

function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return
    throw new ProcessCleanupError({ operation: `signal-${signal}`, processGroupId: pid })
  }
}

function startPty(
  request: ProcessStartRequest,
  attach: (terminal: Bun.Terminal | undefined) => void,
) {
  return Effect.gen(function* () {
    const drained = Promise.withResolvers<void>()
    const child = yield* Effect.try({
      try: () =>
        Bun.spawn([...request.command], {
          detached: true,
          cwd: request.cwd,
          env: { ...request.env, TERM: 'xterm-256color' },
          terminal: {
            cols: Math.max(1, request.size.columns),
            rows: Math.max(1, request.size.rows),
            data: (_terminal, bytes) => request.output(bytes),
            exit: () => drained.resolve(),
          },
        }),
      catch: () => new ProcessStartError({ operation: 'spawn' }),
    })

    const cleanupLock = yield* Semaphore.make(1)
    let cleaned = false
    const awaitExit = Effect.tryPromise({
      try: () => child.exited,
      catch: () => new ProcessCleanupError({ operation: 'wait', processGroupId: child.pid }),
    })
    const cleanup = cleanupLock.withPermit(
      Effect.gen(function* () {
        if (cleaned) return
        yield* Effect.sync(() => {
          try {
            attach(undefined)
          } catch {
            // The process group must be released even if the terminal adapter has already failed.
          }
        })
        yield* Effect.sync(() => signalGroup(child.pid, 'SIGTERM'))
        const exitedAfterTerm = yield* awaitExit.pipe(Effect.timeoutOption('3 seconds'))
        if (Option.isNone(exitedAfterTerm)) {
          yield* Effect.sync(() => signalGroup(child.pid, 'SIGKILL'))
          yield* awaitExit
        }
        const drainedTerminal = yield* Effect.promise(() => drained.promise).pipe(
          Effect.timeoutOption('1 second'),
        )
        if (Option.isNone(drainedTerminal))
          return yield* Effect.fail(
            new ProcessCleanupError({ operation: 'drain', processGroupId: child.pid }),
          )
        cleaned = true
      }).pipe(
        Effect.ensuring(Effect.sync(() => child.terminal?.close())),
        Effect.withSpan('process.release'),
      ),
    )

    if (!child.terminal) {
      const cleanupResult = yield* Effect.result(cleanup)
      if (Result.isFailure(cleanupResult))
        return yield* Effect.fail(
          new ProcessStartError({
            operation: cleanupResult.failure.operation,
            processGroupId: cleanupResult.failure.processGroupId,
          }),
        )
      return yield* Effect.fail(new ProcessStartError({ operation: 'attach' }))
    }
    const attached = yield* Effect.result(
      Effect.try({
        try: () => attach(child.terminal),
        catch: () => new ProcessStartError({ operation: 'attach' }),
      }),
    )
    if (Result.isFailure(attached)) {
      const cleanupResult = yield* Effect.result(cleanup)
      if (Result.isFailure(cleanupResult))
        return yield* Effect.fail(
          new ProcessStartError({
            operation: cleanupResult.failure.operation,
            processGroupId: cleanupResult.failure.processGroupId,
          }),
        )
      return yield* Effect.fail(attached.failure)
    }
    const run: ProcessRun = {
      write: (bytes) =>
        Effect.try({
          try: () => {
            child.terminal?.write(bytes)
          },
          catch: () => new ProcessIoError({ operation: 'write' }),
        }),
      resize: (size) =>
        Effect.try({
          try: () => {
            child.terminal?.resize(Math.max(1, size.columns), Math.max(1, size.rows))
          },
          catch: () => new ProcessIoError({ operation: 'resize' }),
        }),
      awaitExit: Effect.tryPromise({
        try: () => child.exited,
        catch: () => new ProcessRuntimeError({ operation: 'exit' }),
      }).pipe(
        Effect.tap((exitCode) =>
          Effect.annotateCurrentSpan('process.exitCode', exitCode).pipe(
            Effect.andThen(Effect.logInfo('Process exited')),
            Effect.annotateLogs({ exitCode }),
          ),
        ),
        Effect.withSpan('process.run', {
          attributes: {
            'command.name': request.name,
            'command.run': request.run,
            'process.pid': child.pid,
          },
        }),
      ),
      cleanup,
    }
    yield* Effect.logInfo('Process started').pipe(
      Effect.annotateLogs({ 'command.name': request.name }),
    )
    return run
  }).pipe(Effect.uninterruptible)
}

export const ptyProcessDriver = ProcessDriver.of({
  start: (request) => startPty(request, () => {}),
})

export const ptyProcessDriverLayer = Layer.succeed(ProcessDriver, ptyProcessDriver)

export const runPty = Effect.fn('process.run.compatibility')(function* (
  command: readonly [string, ...string[]],
  port: TerminalPort,
  options: {
    readonly cwd?: string
    readonly env?: Readonly<Record<string, string | undefined>>
  } = {},
) {
  const run = yield* startPty(
    {
      name: 'compatibility',
      run: 1,
      command,
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      size: { columns: port.columns, rows: port.rows },
      output: port.output,
    },
    port.attach,
  )
  return yield* run.awaitExit.pipe(Effect.onExit(() => run.cleanup))
})
