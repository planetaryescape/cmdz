import { Effect } from 'effect'

import {
  ProcessCleanupError,
  type ProcessDriver,
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

async function raceTimeout<A, B>(promise: Promise<A>, milliseconds: number, timeout: () => B) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<B>((resolve, reject) => {
        timer = setTimeout(() => {
          try {
            resolve(timeout())
          } catch (error) {
            reject(error)
          }
        }, milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
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

    let cleanupPromise: Promise<void> | undefined
    let cleaned = false
    const cleanup = Effect.tryPromise({
      try: () => {
        if (cleaned) return Promise.resolve()
        if (cleanupPromise) return cleanupPromise
        cleanupPromise = (async () => {
          attach(undefined)
          try {
            signalGroup(child.pid, 'SIGTERM')
            await raceTimeout(child.exited, 3000, () => undefined)
            signalGroup(child.pid, 'SIGKILL')
            await child.exited
            await raceTimeout(drained.promise, 1000, () => {
              throw new ProcessCleanupError({
                operation: 'drain',
                processGroupId: child.pid,
              })
            })
            cleaned = true
          } finally {
            child.terminal?.close()
          }
        })().finally(() => {
          cleanupPromise = undefined
        })
        return cleanupPromise
      },
      catch: (error) =>
        error instanceof ProcessCleanupError
          ? error
          : new ProcessCleanupError({ operation: 'cleanup', processGroupId: child.pid }),
    }).pipe(Effect.withSpan('process.release'))

    if (!child.terminal) {
      yield* Effect.result(cleanup)
      return yield* Effect.fail(new ProcessStartError({ operation: 'attach' }))
    }
    attach(child.terminal)
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
  })
}

export const ptyProcessDriver: ProcessDriver = {
  start: (request) => startPty(request, () => {}),
}

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
