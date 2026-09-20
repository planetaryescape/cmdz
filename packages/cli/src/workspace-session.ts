import { createWorkspaceController } from '@cmdz/core/workspace'
import type { WorkspaceDefinition } from '@cmdz/core/workspace-definition'
import { renderWorkspaceView } from '@cmdz/tui/workspace-view'
import type { CliRenderer } from '@opentui/core'
import { Effect } from 'effect'

import { ptyProcessDriverLayer } from './pty-process'

/** Composes the production PTY driver, workspace runtime, and OpenTUI adapter. */
export const runWorkspace = (renderer: CliRenderer, definitions: readonly WorkspaceDefinition[]) =>
  Effect.gen(function* () {
    const controller = yield* createWorkspaceController(definitions).pipe(
      Effect.provide(ptyProcessDriverLayer),
    )
    yield* renderWorkspaceView(renderer, definitions, controller)
  }).pipe(Effect.scoped)
