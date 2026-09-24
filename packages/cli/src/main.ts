import { Effect, Exit } from 'effect'

import { Command } from './command'
import { loadConfig } from './config'
import {
  findShutdownError,
  formatFailureDiagnostic,
  formatShutdownDiagnostic,
} from './shutdown-diagnostic'
import { telemetry } from './telemetry'
import { terminalSession } from './terminal-session'

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
    console.error(formatFailureDiagnostic(exit.cause))
    process.exitCode = 1
  } else if (Exit.isFailure(exit)) {
    const shutdownError = findShutdownError(exit.cause)
    if (shutdownError) {
      console.error(formatShutdownDiagnostic(shutdownError))
      process.exitCode = 1
    }
  }
} finally {
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', interrupt)
}
