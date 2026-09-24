import {
  ProcessCleanupError,
  ProcessDriver,
  ProcessIoError,
  type ProcessRun,
  ProcessRuntimeError,
  ProcessStartError,
  type ProcessStartRequest,
  normalizeTerminalSize,
} from '@cmdz/core/process-driver'
import { Effect, Layer, Option, Result, Semaphore } from 'effect'

type GroupPresence = 'present' | 'absent'

const postKillTimeout = '3 seconds'

interface TerminalPort {
  readonly columns: number
  readonly rows: number
  readonly output: (bytes: Uint8Array) => void
  readonly attach: (terminal: Bun.Terminal | undefined) => void
}

const signalGroup = (processGroupId: number, signal: NodeJS.Signals) =>
  Effect.try({
    try: () => {
      try {
        process.kill(-processGroupId, signal)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return
        throw error
      }
    },
    catch: () => new ProcessCleanupError({ operation: `signal-${signal}`, processGroupId }),
  })

const groupPresence = (processGroupId: number): Effect.Effect<GroupPresence, ProcessCleanupError> =>
  Effect.try({
    try: () => {
      try {
        // Bun 1.4 rejects signal 0 on Darwin. During release, SIGCONT is a safe
        // liveness probe because any remaining member is immediately force-killed.
        process.kill(-processGroupId, process.platform === 'darwin' ? 'SIGCONT' : 0)
        return 'present' as const
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
          return 'absent' as const
        throw error
      }
    },
    catch: () => new ProcessCleanupError({ operation: 'verify-group', processGroupId }),
  })

const waitForGroupAbsence = (processGroupId: number) =>
  Effect.gen(function* () {
    // Zombies still belong to the group until reaped, so they intentionally keep
    // cleanup unresolved rather than allowing a false successful release.
    while ((yield* groupPresence(processGroupId)) === 'present') yield* Effect.sleep('25 millis')
  }).pipe(
    Effect.timeoutOption(postKillTimeout),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new ProcessCleanupError({ operation: 'verify-group', processGroupId })),
        onSome: Effect.succeed,
      }),
    ),
  )

const releaseGroup = (
  processGroupId: number,
  awaitLeader: Effect.Effect<number, ProcessCleanupError>,
) =>
  Effect.gen(function* () {
    yield* signalGroup(processGroupId, 'SIGTERM')
    const exitedAfterTerm = yield* awaitLeader.pipe(Effect.timeoutOption('3 seconds'))
    const presenceAfterTerm = yield* groupPresence(processGroupId)
    if (presenceAfterTerm === 'present') {
      yield* signalGroup(processGroupId, 'SIGKILL')
      yield* Effect.all(
        {
          leader: Option.isNone(exitedAfterTerm)
            ? awaitLeader.pipe(
                Effect.timeoutOption(postKillTimeout),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(
                        new ProcessCleanupError({
                          operation: 'wait',
                          processGroupId,
                        }),
                      ),
                    onSome: Effect.succeed,
                  }),
                ),
              )
            : Effect.void,
          group: waitForGroupAbsence(processGroupId),
        },
        { concurrency: 'unbounded' },
      )
    } else if (Option.isNone(exitedAfterTerm)) {
      const exitedAfterGroup = yield* awaitLeader.pipe(Effect.timeoutOption(postKillTimeout))
      if (Option.isNone(exitedAfterGroup))
        return yield* Effect.fail(new ProcessCleanupError({ operation: 'wait', processGroupId }))
    }
  })

function startPty(
  request: ProcessStartRequest,
  attach: (terminal: Bun.Terminal | undefined) => void,
) {
  return Effect.gen(function* () {
    const drained = Promise.withResolvers<void>()
    const initialSize = normalizeTerminalSize(request.size.columns, request.size.rows)
    const child = yield* Effect.try({
      try: () =>
        Bun.spawn([...request.command], {
          detached: true,
          cwd: request.cwd,
          env: { ...process.env, ...request.env, TERM: 'xterm-256color' },
          terminal: {
            cols: initialSize.columns,
            rows: initialSize.rows,
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
        yield* releaseGroup(child.pid, awaitExit)
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
            const normalized = normalizeTerminalSize(size.columns, size.rows)
            child.terminal?.resize(normalized.columns, normalized.rows)
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

const make = (attach: (terminal: Bun.Terminal | undefined) => void) =>
  ProcessDriver.of({
    start: (request) => startPty(request, attach),
  })

export const makePtyProcessDriver = () => make(() => {})

export const ptyProcessDriverLayer = Layer.sync(ProcessDriver, makePtyProcessDriver)

export const runPty = Effect.fn('process.run.compatibility')(function* (
  command: readonly [string, ...string[]],
  port: TerminalPort,
  options: {
    readonly cwd?: string
    readonly env?: Readonly<Record<string, string | undefined>>
  } = {},
) {
  const driver = make(port.attach)
  const run = yield* driver.start({
    name: 'compatibility',
    run: 1,
    command,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    size: { columns: port.columns, rows: port.rows },
    output: port.output,
  })
  return yield* run.awaitExit.pipe(Effect.onExit(() => run.cleanup))
})
