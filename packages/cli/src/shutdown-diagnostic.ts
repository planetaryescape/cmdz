import { WorkspaceShutdownError } from '@cmdz/core/workspace'
import { Cause } from 'effect'

export function findShutdownError(cause: Cause.Cause<unknown>) {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && reason.error instanceof WorkspaceShutdownError)
      return reason.error
  }
  return undefined
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
