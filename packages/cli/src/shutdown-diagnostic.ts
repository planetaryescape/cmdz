import { WorkspaceShutdownError } from '@cmdz/core/workspace'
import { Cause } from 'effect'

export function findShutdownError(cause: Cause.Cause<unknown>) {
  let found: WorkspaceShutdownError | undefined
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && reason.error instanceof WorkspaceShutdownError) {
      found = found
        ? new WorkspaceShutdownError({ failures: [...found.failures, ...reason.error.failures] })
        : reason.error
    }
  }
  return found
}

export function formatFailureDiagnostic(cause: Cause.Cause<unknown>) {
  const shutdownError = findShutdownError(cause)
  if (!shutdownError) return Cause.pretty(cause)
  const otherReasons = cause.reasons.filter(
    (reason) => !(Cause.isFailReason(reason) && reason.error instanceof WorkspaceShutdownError),
  )
  const shutdownDiagnostic = formatShutdownDiagnostic(shutdownError)
  return otherReasons.length === 0
    ? shutdownDiagnostic
    : `${Cause.pretty(Cause.fromReasons(otherReasons))}\n${shutdownDiagnostic}`
}

export function formatShutdownDiagnostic(error: WorkspaceShutdownError) {
  const lines = ['cmdz could not clean up every process.']
  for (const failure of error.failures) {
    const run = `${failure.name} run ${failure.run}: cleanup failed during ${failure.operation}.`
    lines.push(
      failure.processGroupId === undefined
        ? run
        : `${run} Process group ${failure.processGroupId} may still be running; stop it manually.`,
    )
  }
  return lines.join('\n')
}
