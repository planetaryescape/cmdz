import { Context, Data, Schema, type Effect } from 'effect'

export const TerminalSize = Schema.Struct({
  columns: Schema.Int.check(Schema.isGreaterThan(0)),
  rows: Schema.Int.check(Schema.isGreaterThan(0)),
})

export type TerminalSize = typeof TerminalSize.Type

export const normalizeTerminalSize = (columns: number, rows: number): TerminalSize =>
  Schema.decodeUnknownSync(TerminalSize)({
    columns: Math.max(1, columns),
    rows: Math.max(1, rows),
  })

export class ProcessStartError extends Data.TaggedError('ProcessStartError')<{
  readonly operation: string
  readonly processGroupId?: number | undefined
}> {}

export class ProcessIoError extends Data.TaggedError('ProcessIoError')<{
  readonly operation: string
}> {}

export class ProcessRuntimeError extends Data.TaggedError('ProcessRuntimeError')<{
  readonly operation: string
}> {}

export class ProcessCleanupError extends Data.TaggedError('ProcessCleanupError')<{
  readonly operation: string
  readonly processGroupId?: number | undefined
}> {}

export interface ProcessStartRequest {
  readonly name: string
  readonly run: number
  readonly command: readonly [string, ...string[]]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly size: TerminalSize
  readonly output: (bytes: Uint8Array) => void
}

export interface ProcessRun {
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, ProcessIoError>
  readonly resize: (size: TerminalSize) => Effect.Effect<void, ProcessIoError>
  readonly awaitExit: Effect.Effect<number, ProcessRuntimeError>
  /** Releases this run's resources; repeated or concurrent evaluations must safely coalesce. */
  readonly cleanup: Effect.Effect<void, ProcessCleanupError>
}

export interface ProcessDriverService {
  readonly start: (request: ProcessStartRequest) => Effect.Effect<ProcessRun, ProcessStartError>
}

export class ProcessDriver extends Context.Service<ProcessDriver, ProcessDriverService>()(
  '@cmdz/ProcessDriver',
) {}
