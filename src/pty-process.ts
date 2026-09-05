import { Effect, Schema } from 'effect'

export class ProcessError extends Schema.TaggedError<ProcessError>()('ProcessError', {
  operation: Schema.String,
}) {}

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
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
}

export const runPty = Effect.fn('process.run')(function* (
  command: readonly [string, ...string[]],
  port: TerminalPort,
  options: {
    readonly cwd?: string
    readonly env?: Readonly<Record<string, string | undefined>>
  } = {},
) {
  const drained = Promise.withResolvers<void>()
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.spawn([...command], {
          detached: true,
          cwd: options.cwd ?? process.cwd(),
          env: { ...(options.env ?? process.env), TERM: 'xterm-256color' },
          terminal: {
            cols: Math.max(1, port.columns),
            rows: Math.max(1, port.rows),
            data: (_terminal, bytes) => port.output(bytes),
            exit: () => drained.resolve(),
          },
        }),
      catch: () => new ProcessError({ operation: 'spawn' }),
    }),
    (child) =>
      Effect.promise(async () => {
        port.attach(undefined)
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          signalGroup(child.pid, 'SIGTERM')
          await Promise.race([
            child.exited,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 3000)
            }),
          ])
          signalGroup(child.pid, 'SIGKILL')
          await child.exited
          clearTimeout(timer)
          await Promise.race([
            drained.promise,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new ProcessError({ operation: 'drain' })), 1000)
            }),
          ])
        } finally {
          clearTimeout(timer)
          child.terminal?.close()
        }
      }).pipe(Effect.withSpan('process.release')),
  )

  if (!child.terminal) return yield* Effect.fail(new ProcessError({ operation: 'attach' }))
  yield* Effect.sync(() => port.attach(child.terminal))
  yield* Effect.annotateCurrentSpan('process.pid', child.pid)
  yield* Effect.logInfo('Process started')
  const exitCode = yield* Effect.promise(() => child.exited)
  yield* Effect.annotateCurrentSpan('process.exitCode', exitCode)
  yield* Effect.logInfo('Process exited').pipe(Effect.annotateLogs({ exitCode }))
  return exitCode
}, Effect.scoped)
