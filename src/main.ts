import { Cause, Effect, Exit, Option } from 'effect'

import { Command } from './command'
import { loadConfig } from './config'
import { formatShutdownDiagnostic } from './shutdown-diagnostic'
import { telemetry } from './telemetry'
import { terminalSession } from './terminal-session'
import { WorkspaceShutdownError } from './workspace-core'

Bun.plugin({
  name: 'cmdz-config-api',
  setup(builder) {
    builder.module('cmdz', () => ({ loader: 'object', exports: { Command } }))
  },
})

const controller = new AbortController()
const interrupt = () => controller.abort()

process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)

try {
  const exit = await Effect.runPromiseExit(
    loadConfig(process.argv[2] ?? 'cmdz.ts').pipe(
      Effect.flatMap(terminalSession),
      Effect.provide(telemetry),
    ),
    { signal: controller.signal },
  )
  if (Exit.isFailure(exit) && !controller.signal.aborted) {
    const error = Cause.findErrorOption(exit.cause)
    console.error(
      Option.isSome(error) && error.value instanceof WorkspaceShutdownError
        ? formatShutdownDiagnostic(error.value)
        : Cause.pretty(exit.cause),
    )
    process.exitCode = 1
  } else if (Exit.isFailure(exit)) {
    const error = Cause.findErrorOption(exit.cause)
    if (Option.isSome(error) && error.value instanceof WorkspaceShutdownError) {
      console.error(formatShutdownDiagnostic(error.value))
      process.exitCode = 1
    }
  }
} finally {
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', interrupt)
}
