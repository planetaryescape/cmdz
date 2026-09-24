import { Effect } from 'effect'

import type { TerminalSize } from './process-driver'
import type {
  WorkspaceCommandError,
  WorkspaceController,
  WorkspaceSnapshot,
  WorkspaceShutdownError,
} from './workspace'

/**
 * Provides framework-independent access to controller initialization, dispatch,
 * and shutdown.
 */
export interface WorkspaceRuntime {
  readonly initialize: (
    sizes: Readonly<Record<string, TerminalSize>>,
  ) => Effect.Effect<WorkspaceSnapshot, WorkspaceCommandError>
  readonly dispatch: WorkspaceController['dispatch']
  readonly shutdown: Effect.Effect<void, WorkspaceShutdownError>
  /** Forwards an explicit force-quit request to the workspace controller. */
  readonly forceShutdown: Effect.Effect<void>
}

/** Creates the controller runtime consumed by workspace adapters. */
export const createWorkspaceRuntime = (controller: WorkspaceController) =>
  Effect.succeed({
    initialize: controller.initialize,
    dispatch: controller.dispatch,
    shutdown: controller.shutdown,
    forceShutdown: controller.forceShutdown,
  } satisfies WorkspaceRuntime)
