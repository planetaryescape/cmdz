import { Effect, Stream, SubscriptionRef } from 'effect'

import type { ProcessDefinition } from './config'

export type PaneStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'succeeded'
  | 'failed'

export interface PaneSnapshot {
  readonly name: string
  readonly title: string
  readonly status: PaneStatus
  readonly run: number
}

export interface WorkspaceSnapshot {
  readonly panes: readonly PaneSnapshot[]
  readonly selected: string
  readonly input: boolean
  readonly sidebarVisible: boolean
}

export type WorkspaceCommand =
  | { readonly type: 'select'; readonly name: string }
  | { readonly type: 'start'; readonly name: string }
  | { readonly type: 'running'; readonly name: string; readonly run: number }
  | { readonly type: 'stop'; readonly name: string }
  | { readonly type: 'stopped'; readonly name: string; readonly run: number }
  | { readonly type: 'exit'; readonly name: string; readonly run: number; readonly code: number }
  | { readonly type: 'fail'; readonly name: string; readonly run: number }
  | { readonly type: 'input'; readonly value: boolean }
  | { readonly type: 'sidebar'; readonly value: boolean }

export interface WorkspaceCore {
  readonly snapshots: Stream.Stream<WorkspaceSnapshot>
  readonly snapshot: Effect.Effect<WorkspaceSnapshot>
  readonly dispatch: (command: WorkspaceCommand) => Effect.Effect<WorkspaceSnapshot>
}

function updatePane(
  snapshot: WorkspaceSnapshot,
  name: string,
  update: (pane: PaneSnapshot) => PaneSnapshot,
) {
  return {
    ...snapshot,
    panes: snapshot.panes.map((pane) => (pane.name === name ? update(pane) : pane)),
  }
}

function transition(snapshot: WorkspaceSnapshot, command: WorkspaceCommand): WorkspaceSnapshot {
  switch (command.type) {
    case 'select':
      return snapshot.panes.some((pane) => pane.name === command.name)
        ? { ...snapshot, selected: command.name, input: false }
        : snapshot
    case 'start':
      return updatePane(snapshot, command.name, (pane) =>
        pane.status === 'idle' ||
        pane.status === 'stopped' ||
        pane.status === 'succeeded' ||
        pane.status === 'failed'
          ? { ...pane, status: 'starting', run: pane.run + 1 }
          : pane,
      )
    case 'running':
      return updatePane(snapshot, command.name, (pane) =>
        pane.run === command.run && pane.status === 'starting'
          ? { ...pane, status: 'running' }
          : pane,
      )
    case 'stop':
      return updatePane(snapshot, command.name, (pane) =>
        pane.status === 'starting' || pane.status === 'running'
          ? { ...pane, status: 'stopping' }
          : pane,
      )
    case 'stopped':
      return updatePane(snapshot, command.name, (pane) =>
        pane.run === command.run ? { ...pane, status: 'stopped' } : pane,
      )
    case 'exit':
      return updatePane(snapshot, command.name, (pane) =>
        pane.run === command.run
          ? { ...pane, status: command.code === 0 ? 'succeeded' : 'failed' }
          : pane,
      )
    case 'fail':
      return updatePane(snapshot, command.name, (pane) =>
        pane.run === command.run ? { ...pane, status: 'failed' } : pane,
      )
    case 'input':
      return { ...snapshot, input: command.value }
    case 'sidebar':
      return { ...snapshot, sidebarVisible: command.value }
  }
}

export const makeWorkspaceCore = Effect.fn('workspace.core.make')(function* (
  definitions: readonly ProcessDefinition[],
): Effect.fn.Return<WorkspaceCore> {
  const first = definitions[0]
  if (!first) throw new Error('Workspace requires at least one command.')
  const state = yield* SubscriptionRef.make<WorkspaceSnapshot>({
    panes: definitions.map((definition) => ({
      name: definition.name,
      title: definition.title,
      status: 'idle',
      run: 0,
    })),
    selected: first.name,
    input: false,
    sidebarVisible: true,
  })
  return {
    snapshots: SubscriptionRef.changes(state),
    snapshot: SubscriptionRef.get(state),
    dispatch: (command) =>
      SubscriptionRef.getAndUpdate(state, (snapshot) => transition(snapshot, command)).pipe(
        Effect.flatMap(() => SubscriptionRef.get(state)),
      ),
  }
})
