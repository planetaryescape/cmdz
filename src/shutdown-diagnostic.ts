import type { WorkspaceShutdownError } from './workspace-core'

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
