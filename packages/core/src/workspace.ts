import { Data, Effect, Queue, Result, Semaphore, Stream, SubscriptionRef, type Scope } from 'effect'

import {
  ProcessDriver,
  type ProcessIoError,
  type ProcessRun,
  type TerminalSize,
} from './process-driver'
import type { WorkspaceDefinition } from './workspace-definition'

export type PaneFailure = Data.TaggedEnum<{
  readonly StartFailed: { readonly operation: string }
  readonly RuntimeFailed: { readonly operation: string }
  readonly Exited: { readonly exitCode: number }
  readonly CleanupFailed: {
    readonly operation: string
    readonly processGroupId?: number | undefined
    readonly priorExitCode?: number | undefined
    readonly priorRuntimeOperation?: string | undefined
    readonly stopRequested?: boolean | undefined
  }
}>

export const PaneFailure = Data.taggedEnum<PaneFailure>()

export type PaneLifecycle = Data.TaggedEnum<{
  readonly Idle: { readonly lastRun: number }
  readonly Starting: { readonly run: number }
  readonly Running: { readonly run: number }
  readonly Stopping: { readonly run: number }
  readonly Stopped: { readonly run: number }
  readonly Succeeded: { readonly run: number; readonly exitCode: 0 }
  readonly Failed: { readonly run: number; readonly failure: PaneFailure }
}>

export const PaneLifecycle = Data.taggedEnum<PaneLifecycle>()

export interface PaneSnapshot {
  readonly name: string
  readonly title: string
  readonly lifecycle: PaneLifecycle
}

export interface WorkspaceSnapshot {
  readonly panes: readonly PaneSnapshot[]
  readonly selected: string
  readonly mode: 'navigation' | 'input'
  readonly sidebarVisible: boolean
  readonly shuttingDown: boolean
}

export type WorkspaceCommand =
  | { readonly type: 'select'; readonly name: string }
  | { readonly type: 'start'; readonly name: string; readonly size: TerminalSize }
  | { readonly type: 'stop'; readonly name: string }
  | { readonly type: 'restart'; readonly name: string; readonly size: TerminalSize }
  | { readonly type: 'enterInput'; readonly name: string }
  | { readonly type: 'leaveInput' }
  | {
      readonly type: 'write'
      readonly name: string
      readonly source: 'user' | 'terminalResponse'
      readonly bytes: Uint8Array
      readonly run?: number | undefined
    }
  | { readonly type: 'resize'; readonly name: string; readonly size: TerminalSize }
  | { readonly type: 'setSidebarVisible'; readonly visible: boolean }

export type WorkspaceEvent =
  | { readonly type: 'resetTerminal'; readonly name: string; readonly run: number }
  | {
      readonly type: 'output'
      readonly name: string
      readonly run: number
      readonly bytes: Uint8Array
    }

export class WorkspaceCommandError extends Data.TaggedError('WorkspaceCommandError')<{
  readonly reason:
    | 'unknownPane'
    | 'missingTerminalSize'
    | 'paneNotRunning'
    | 'paneAlreadyActive'
    | 'paneCleanupUnresolved'
    | 'workspaceAlreadyInitialized'
    | 'workspaceShuttingDown'
  readonly name?: string | undefined
}> {}

export interface CleanupFailure {
  readonly name: string
  readonly run: number
  readonly operation: string
  readonly processGroupId?: number | undefined
  readonly priorExitCode?: number | undefined
  readonly priorRuntimeOperation?: string | undefined
}

export class WorkspaceShutdownError extends Data.TaggedError('WorkspaceShutdownError')<{
  readonly failures: readonly CleanupFailure[]
}> {}

export interface WorkspaceController {
  readonly snapshots: Stream.Stream<WorkspaceSnapshot>
  readonly events: Stream.Stream<WorkspaceEvent>
  readonly snapshot: Effect.Effect<WorkspaceSnapshot>
  readonly initialize: (
    initialSizes: Readonly<Record<string, TerminalSize>>,
  ) => Effect.Effect<WorkspaceSnapshot, WorkspaceCommandError>
  readonly dispatch: (
    command: WorkspaceCommand,
  ) => Effect.Effect<WorkspaceSnapshot, WorkspaceCommandError | ProcessIoError>
  readonly shutdown: Effect.Effect<void, WorkspaceShutdownError>
}

interface ActiveRun {
  readonly run: number
  readonly process: ProcessRun
}

function paneRun(lifecycle: PaneLifecycle) {
  return lifecycle._tag === 'Idle' ? lifecycle.lastRun : lifecycle.run
}

function isActive(lifecycle: PaneLifecycle) {
  return (
    lifecycle._tag === 'Starting' || lifecycle._tag === 'Running' || lifecycle._tag === 'Stopping'
  )
}

function updatePane(
  snapshot: WorkspaceSnapshot,
  name: string,
  update: (pane: PaneSnapshot) => PaneSnapshot,
): WorkspaceSnapshot {
  return {
    ...snapshot,
    panes: snapshot.panes.map((pane) => (pane.name === name ? update(pane) : pane)),
  }
}

function findPane(snapshot: WorkspaceSnapshot, name: string) {
  return snapshot.panes.find((pane) => pane.name === name)
}

export function renderStatus(lifecycle: PaneLifecycle) {
  switch (lifecycle._tag) {
    case 'Idle':
      return 'idle'
    case 'Starting':
      return 'starting'
    case 'Running':
      return 'running'
    case 'Stopping':
      return 'stopping'
    case 'Stopped':
      return 'stopped'
    case 'Succeeded':
      return 'succeeded'
    case 'Failed':
      return lifecycle.failure._tag === 'Exited'
        ? `failed (${lifecycle.failure.exitCode})`
        : 'failed'
  }
}

export const createWorkspaceController = Effect.fn('workspace.controller.make')(function* (
  definitions: readonly WorkspaceDefinition[],
): Effect.fn.Return<WorkspaceController, never, Scope.Scope | ProcessDriver> {
  const driver = yield* ProcessDriver
  const first = definitions[0]
  if (!first) throw new Error('Workspace requires at least one command.')
  const scope = yield* Effect.scope
  const state = yield* SubscriptionRef.make<WorkspaceSnapshot>({
    panes: definitions.map((definition) => ({
      name: definition.name,
      title: definition.title,
      lifecycle: PaneLifecycle.Idle({ lastRun: 0 }),
    })),
    selected: first.name,
    mode: 'navigation',
    sidebarVisible: true,
    shuttingDown: false,
  })
  const events = yield* Queue.unbounded<WorkspaceEvent>()
  const lifecycle = yield* Semaphore.make(1)
  const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]))
  const activeRuns = new Map<string, ActiveRun>()
  let initialized = false

  const commandError = (reason: WorkspaceCommandError['reason'], name?: string) =>
    new WorkspaceCommandError({ reason, name })

  const setPaneLifecycle = (name: string, run: number, next: PaneLifecycle) =>
    SubscriptionRef.updateAndGet(state, (snapshot): WorkspaceSnapshot => {
      const pane = findPane(snapshot, name)
      if (!pane || paneRun(pane.lifecycle) !== run) return snapshot
      const updated = updatePane(snapshot, name, () => ({ ...pane, lifecycle: next }))
      return snapshot.selected === name && !isActive(next)
        ? { ...updated, mode: 'navigation' }
        : updated
    })

  const completeRun = (
    name: string,
    run: number,
    exitCode: number | undefined,
    runtimeOperation: string | undefined,
  ) =>
    Effect.gen(function* () {
      const active = activeRuns.get(name)
      if (!active || active.run !== run) return
      const cleanup = yield* Effect.result(active.process.cleanup)
      yield* lifecycle.withPermit(
        Effect.gen(function* () {
          const currentActive = activeRuns.get(name)
          if (
            !currentActive ||
            currentActive.run !== run ||
            currentActive.process !== active.process
          )
            return
          const snapshot = yield* SubscriptionRef.get(state)
          const pane = findPane(snapshot, name)
          if (!pane || paneRun(pane.lifecycle) !== run) return
          if (Result.isFailure(cleanup)) {
            yield* setPaneLifecycle(
              name,
              run,
              PaneLifecycle.Failed({
                run,
                failure: PaneFailure.CleanupFailed({
                  operation: cleanup.failure.operation,
                  processGroupId: cleanup.failure.processGroupId,
                  priorExitCode: exitCode,
                  priorRuntimeOperation: runtimeOperation,
                  stopRequested: pane.lifecycle._tag === 'Stopping',
                }),
              }),
            )
            return
          }
          activeRuns.delete(name)
          if (pane.lifecycle._tag === 'Stopping') {
            yield* setPaneLifecycle(name, run, PaneLifecycle.Stopped({ run }))
          } else if (runtimeOperation) {
            yield* setPaneLifecycle(
              name,
              run,
              PaneLifecycle.Failed({
                run,
                failure: PaneFailure.RuntimeFailed({ operation: runtimeOperation }),
              }),
            )
          } else if (exitCode === 0) {
            yield* setPaneLifecycle(name, run, PaneLifecycle.Succeeded({ run, exitCode: 0 }))
          } else if (exitCode !== undefined) {
            yield* setPaneLifecycle(
              name,
              run,
              PaneLifecycle.Failed({ run, failure: PaneFailure.Exited({ exitCode }) }),
            )
          }
        }),
      )
    })

  const watchRun = (name: string, run: number, process: ProcessRun) =>
    process.awaitExit.pipe(
      Effect.matchEffect({
        onFailure: (error) => completeRun(name, run, undefined, error.operation),
        onSuccess: (code) => completeRun(name, run, code, undefined),
      }),
    )

  const startLocked = (name: string, size: TerminalSize) =>
    Effect.gen(function* () {
      const snapshot = yield* SubscriptionRef.get(state)
      if (snapshot.shuttingDown)
        return yield* Effect.fail(commandError('workspaceShuttingDown', name))
      const definition = definitionsByName.get(name)
      const pane = findPane(snapshot, name)
      if (!definition || !pane) return yield* Effect.fail(commandError('unknownPane', name))
      if (isActive(pane.lifecycle))
        return yield* Effect.fail(commandError('paneAlreadyActive', name))
      if (pane.lifecycle._tag === 'Failed' && pane.lifecycle.failure._tag === 'CleanupFailed')
        return yield* Effect.fail(commandError('paneCleanupUnresolved', name))
      const run = paneRun(pane.lifecycle) + 1
      yield* SubscriptionRef.update(state, (current) =>
        updatePane(current, name, (currentPane) => ({
          ...currentPane,
          lifecycle: PaneLifecycle.Starting({ run }),
        })),
      )
      yield* Queue.offer(events, { type: 'resetTerminal', name, run })
      const started = yield* Effect.uninterruptible(
        driver
          .start({
            name,
            run,
            command: ['/bin/sh', '-c', definition.command],
            cwd: definition.cwd,
            env: definition.env,
            size,
            output: (bytes) => {
              const current = SubscriptionRef.getUnsafe(state)
              const currentPane = findPane(current, name)
              if (
                currentPane &&
                paneRun(currentPane.lifecycle) === run &&
                isActive(currentPane.lifecycle)
              )
                Queue.offerUnsafe(events, { type: 'output', name, run, bytes })
            },
          })
          .pipe(Effect.result),
      )
      if (Result.isFailure(started)) {
        return yield* setPaneLifecycle(
          name,
          run,
          PaneLifecycle.Failed({
            run,
            failure: PaneFailure.StartFailed({ operation: started.failure.operation }),
          }),
        )
      }
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          activeRuns.set(name, { run, process: started.success })
          yield* setPaneLifecycle(name, run, PaneLifecycle.Running({ run }))
          yield* Effect.forkIn(watchRun(name, run, started.success), scope)
        }),
      )
      return yield* SubscriptionRef.get(state)
    })

  const stopLocked = (name: string) =>
    Effect.gen(function* () {
      const snapshot = yield* SubscriptionRef.get(state)
      const pane = findPane(snapshot, name)
      if (!pane) return yield* Effect.fail(commandError('unknownPane', name))
      if (!isActive(pane.lifecycle)) return snapshot
      const run = paneRun(pane.lifecycle)
      const active = activeRuns.get(name)
      if (!active || active.run !== run)
        return yield* Effect.fail(commandError('paneNotRunning', name))
      yield* setPaneLifecycle(name, run, PaneLifecycle.Stopping({ run }))
      const cleanup = yield* Effect.result(active.process.cleanup)
      if (Result.isFailure(cleanup)) {
        return yield* setPaneLifecycle(
          name,
          run,
          PaneLifecycle.Failed({
            run,
            failure: PaneFailure.CleanupFailed({
              operation: cleanup.failure.operation,
              processGroupId: cleanup.failure.processGroupId,
              stopRequested: true,
            }),
          }),
        )
      }
      activeRuns.delete(name)
      return yield* setPaneLifecycle(name, run, PaneLifecycle.Stopped({ run }))
    })

  const initialize = (initialSizes: Readonly<Record<string, TerminalSize>>) =>
    lifecycle.withPermit(
      Effect.gen(function* () {
        if (initialized) return yield* Effect.fail(commandError('workspaceAlreadyInitialized'))
        for (const definition of definitions)
          if (!initialSizes[definition.name])
            return yield* Effect.fail(commandError('missingTerminalSize', definition.name))
        initialized = true
        for (const definition of definitions) {
          if (!definition.autostart) continue
          const size = initialSizes[definition.name]
          if (!size) return yield* Effect.fail(commandError('missingTerminalSize', definition.name))
          yield* startLocked(definition.name, size)
        }
        return yield* SubscriptionRef.get(state)
      }),
    )

  const dispatch = (command: WorkspaceCommand) => {
    if (command.type === 'write' || command.type === 'resize')
      return Effect.gen(function* () {
        const snapshot = yield* SubscriptionRef.get(state)
        if (snapshot.shuttingDown)
          return yield* Effect.fail(commandError('workspaceShuttingDown', command.name))
        const pane = findPane(snapshot, command.name)
        if (!pane) return yield* Effect.fail(commandError('unknownPane', command.name))
        if (command.type === 'resize' && pane.lifecycle._tag !== 'Running') return snapshot
        if (
          pane.lifecycle._tag !== 'Running' ||
          (command.type === 'write' &&
            command.source === 'terminalResponse' &&
            command.run !== pane.lifecycle.run) ||
          (command.type === 'write' &&
            command.source === 'user' &&
            (snapshot.selected !== command.name || snapshot.mode !== 'input'))
        )
          return yield* Effect.fail(commandError('paneNotRunning', command.name))
        const active = activeRuns.get(command.name)
        if (!active || active.run !== pane.lifecycle.run)
          return yield* Effect.fail(commandError('paneNotRunning', command.name))
        if (command.type === 'write') yield* active.process.write(command.bytes)
        else yield* active.process.resize(command.size)
        return yield* SubscriptionRef.get(state)
      })

    return lifecycle.withPermit(
      Effect.gen(function* () {
        const snapshot = yield* SubscriptionRef.get(state)
        if (snapshot.shuttingDown)
          return yield* Effect.fail(
            commandError(
              'workspaceShuttingDown',
              command.type === 'leaveInput' || command.type === 'setSidebarVisible'
                ? undefined
                : command.name,
            ),
          )
        switch (command.type) {
          case 'start':
            return yield* startLocked(command.name, command.size)
          case 'stop':
            return yield* stopLocked(command.name)
          case 'restart': {
            const stopped = yield* stopLocked(command.name)
            const pane = findPane(stopped, command.name)
            if (
              pane?.lifecycle._tag === 'Failed' &&
              pane.lifecycle.failure._tag === 'CleanupFailed'
            )
              return yield* Effect.fail(commandError('paneCleanupUnresolved', command.name))
            return yield* startLocked(command.name, command.size)
          }
          case 'select':
            if (!findPane(snapshot, command.name))
              return yield* Effect.fail(commandError('unknownPane', command.name))
            return yield* SubscriptionRef.updateAndGet(state, (current): WorkspaceSnapshot => ({
              ...current,
              selected: command.name,
              mode: 'navigation',
            }))
          case 'enterInput': {
            const pane = findPane(snapshot, command.name)
            if (!pane || snapshot.selected !== command.name || pane.lifecycle._tag !== 'Running')
              return yield* Effect.fail(commandError('paneNotRunning', command.name))
            return yield* SubscriptionRef.updateAndGet(state, (current): WorkspaceSnapshot => ({
              ...current,
              mode: 'input',
            }))
          }
          case 'leaveInput':
            return yield* SubscriptionRef.updateAndGet(state, (current): WorkspaceSnapshot => ({
              ...current,
              mode: 'navigation',
            }))
          case 'setSidebarVisible':
            return yield* SubscriptionRef.updateAndGet(state, (current) => ({
              ...current,
              sidebarVisible: command.visible,
            }))
        }
      }),
    )
  }

  const shutdownEffect = lifecycle.withPermit(
    Effect.gen(function* () {
      yield* SubscriptionRef.update(state, (snapshot): WorkspaceSnapshot => ({
        ...snapshot,
        mode: 'navigation',
        shuttingDown: true,
      }))
      const failures: CleanupFailure[] = []
      for (const [name, active] of Array.from(activeRuns)) {
        const cleanup = yield* Effect.result(active.process.cleanup)
        if (Result.isFailure(cleanup)) {
          const snapshot = yield* SubscriptionRef.get(state)
          const pane = findPane(snapshot, name)
          const priorExitCode =
            pane?.lifecycle._tag === 'Failed' && pane.lifecycle.failure._tag === 'CleanupFailed'
              ? pane.lifecycle.failure.priorExitCode
              : undefined
          const stopRequested =
            pane?.lifecycle._tag === 'Failed' && pane.lifecycle.failure._tag === 'CleanupFailed'
              ? pane.lifecycle.failure.stopRequested
              : undefined
          const priorRuntimeOperation =
            pane?.lifecycle._tag === 'Failed' && pane.lifecycle.failure._tag === 'CleanupFailed'
              ? pane.lifecycle.failure.priorRuntimeOperation
              : undefined
          failures.push({
            name,
            run: active.run,
            operation: cleanup.failure.operation,
            processGroupId: cleanup.failure.processGroupId,
            priorExitCode,
            priorRuntimeOperation,
          })
          yield* setPaneLifecycle(
            name,
            active.run,
            PaneLifecycle.Failed({
              run: active.run,
              failure: PaneFailure.CleanupFailed({
                operation: cleanup.failure.operation,
                processGroupId: cleanup.failure.processGroupId,
                priorExitCode,
                priorRuntimeOperation,
                stopRequested,
              }),
            }),
          )
        } else {
          activeRuns.delete(name)
          const snapshot = yield* SubscriptionRef.get(state)
          const pane = findPane(snapshot, name)
          const failedCleanup =
            pane?.lifecycle._tag === 'Failed' && pane.lifecycle.failure._tag === 'CleanupFailed'
              ? pane.lifecycle.failure
              : undefined
          if (failedCleanup?.stopRequested)
            yield* setPaneLifecycle(name, active.run, PaneLifecycle.Stopped({ run: active.run }))
          else if (failedCleanup?.priorRuntimeOperation)
            yield* setPaneLifecycle(
              name,
              active.run,
              PaneLifecycle.Failed({
                run: active.run,
                failure: PaneFailure.RuntimeFailed({
                  operation: failedCleanup.priorRuntimeOperation,
                }),
              }),
            )
          else if (failedCleanup?.priorExitCode === 0)
            yield* setPaneLifecycle(
              name,
              active.run,
              PaneLifecycle.Succeeded({
                run: active.run,
                exitCode: 0,
              }),
            )
          else if (failedCleanup?.priorExitCode !== undefined)
            yield* setPaneLifecycle(
              name,
              active.run,
              PaneLifecycle.Failed({
                run: active.run,
                failure: PaneFailure.Exited({ exitCode: failedCleanup.priorExitCode }),
              }),
            )
          else yield* setPaneLifecycle(name, active.run, PaneLifecycle.Stopped({ run: active.run }))
        }
      }
      if (failures.length > 0) return yield* Effect.fail(new WorkspaceShutdownError({ failures }))
    }).pipe(Effect.uninterruptible),
  )
  const shutdown = yield* Effect.cached(shutdownEffect)
  yield* Effect.addFinalizer(() =>
    shutdown.pipe(
      Effect.catch((error) =>
        Effect.logError('Workspace cleanup failed').pipe(
          Effect.annotateLogs({ failures: error.failures.length }),
        ),
      ),
    ),
  )

  return {
    snapshots: SubscriptionRef.changes(state),
    events: Stream.fromQueue(events),
    snapshot: SubscriptionRef.get(state),
    initialize,
    dispatch,
    shutdown,
  }
})
