import { expect, test } from 'bun:test'

import { PaneOutcome, WorkspaceCommandError, WorkspaceShutdownError } from '@cmdz/core/workspace'
import { Cause } from 'effect'

import {
  findShutdownError,
  formatFailureDiagnostic,
  formatShutdownDiagnostic,
} from './shutdown-diagnostic'

test('reports every unresolved process group without process data', () => {
  const diagnostic = formatShutdownDiagnostic(
    new WorkspaceShutdownError({
      failures: [
        {
          name: 'Web',
          run: 3,
          operation: 'signal-SIGKILL',
          processGroupId: 4312,
          target: PaneOutcome.Stopped(),
        },
        { name: 'Worker', run: 2, operation: 'drain', target: PaneOutcome.Stopped() },
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

test('finds shutdown cleanup failure when another failure occurred first', () => {
  const firstShutdown = new WorkspaceShutdownError({
    failures: [
      {
        name: 'Web',
        run: 3,
        operation: 'signal-SIGKILL',
        processGroupId: 4312,
        target: PaneOutcome.Stopped(),
      },
    ],
  })
  const secondShutdown = new WorkspaceShutdownError({
    failures: [{ name: 'Worker', run: 2, operation: 'drain', target: PaneOutcome.Stopped() }],
  })
  const cause = Cause.combine(
    Cause.combine(
      Cause.fail(new WorkspaceCommandError({ reason: 'workspaceAlreadyInitialized' })),
      Cause.fail(firstShutdown),
    ),
    Cause.fail(secondShutdown),
  )

  expect(findShutdownError(cause)?.failures).toEqual([
    ...firstShutdown.failures,
    ...secondShutdown.failures,
  ])
  const diagnostic = formatFailureDiagnostic(cause)
  expect(diagnostic).toContain('WorkspaceCommandError')
  expect(diagnostic).toContain('Web run 3')
  expect(diagnostic).toContain('Worker run 2')
  expect(diagnostic.match(/cmdz could not clean up every process\./g)).toHaveLength(1)
})
