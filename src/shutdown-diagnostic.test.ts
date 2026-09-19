import { expect, test } from 'bun:test'

import { formatShutdownDiagnostic } from './shutdown-diagnostic'
import { WorkspaceShutdownError } from './workspace-core'

test('reports every unresolved process group without process data', () => {
  const diagnostic = formatShutdownDiagnostic(
    new WorkspaceShutdownError({
      failures: [
        { name: 'Web', run: 3, operation: 'signal-SIGKILL', processGroupId: 4312 },
        { name: 'Worker', run: 2, operation: 'drain' },
      ],
    }),
  )

  expect(diagnostic).toBe(
    [
      'cmdz could not clean up every process.',
      'Web run 3: cleanup failed during signal-SIGKILL. Process group 4312 may still be running; stop it manually.',
      'Worker run 2: cleanup failed during drain.',
    ].join('\n'),
  )
  expect(diagnostic).not.toContain('command')
  expect(diagnostic).not.toContain('environment')
  expect(diagnostic).not.toContain('output')
})
