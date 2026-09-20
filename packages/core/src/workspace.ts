import { Data, Effect, Queue, Result, Semaphore, Stream, SubscriptionRef, type Scope } from 'effect'

import {
  ProcessDriver,
  type ProcessIoError,
  type ProcessRun,
  type TerminalSize,
} from './process-driver'
import type { WorkspaceDefinition } from './workspace-definition'

/** The user-visible outcome of a run after the controller releases its resources. */
export type PaneOutcome = Data.TaggedEnum<{
  readonly Idle: Record<never, never>
  readonly Stopped: Record<never, never>
  readonly Succeeded: { readonly exitCode: 0 }
  readonly StartFailed: { readonly operation: string }
  readonly RuntimeFailed: { readonly operation: string }
  readonly Exited: { readonly exitCode: number }
}>

/** Constructors and matchers for pane outcomes. */
export const PaneOutcome = Data.taggedEnum<PaneOutcome>()

/** Outcomes available once a process was successfully started. */
export type PaneTerminalOutcome = Exclude<PaneOutcome, { readonly _tag: 'Idle' | 'StartFailed' }>

/** Cleanup progress for a run whose process resources are still owned by the controller. */
export type PaneCleanup = Data.TaggedEnum<{
  readonly Pending: Record<never, never>
  readonly Failed: {
    readonly operation: string
    readonly processGroupId?: number | undefined
  }
}>

/** Constructors and matchers for pane cleanup progress. */
export const PaneCleanup = Data.taggedEnum<PaneCleanup>()

/** The observable ownership lifecycle of a pane. */
export type PaneLifecycle = Data.TaggedEnum<{
  readonly Ready: { readonly lastRun: number; readonly outcome: PaneOutcome }
  readonly Starting: { readonly run: number }
  readonly Running: { readonly run: number }
  readonly Cleaning: {
    readonly run: number
    readonly target: PaneTerminalOutcome
    readonly cleanup: PaneCleanup
  }
}>

/** Constructors and matchers for observable pane lifecycle states. */
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
  readonly target: PaneTerminalOutcome
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

type InternalPaneLifecycle =
  | Extract<PaneLifecycle, { readonly _tag: 'Ready' | 'Starting' }>
  | (Extract<PaneLifecycle, { readonly _tag: 'Running' }> & {
      readonly process: ProcessRun
    })
  | (Extract<PaneLifecycle, { readonly _tag: 'Cleaning' }> & {
      readonly process: ProcessRun
    })

interface InternalPane {
  readonly name: string
  readonly title: string
  readonly lifecycle: InternalPaneLifecycle
}

interface ControllerState {
  readonly panes: readonly InternalPane[]
  readonly selected: string
  readonly mode: 'navigation' | 'input'
  readonly sidebarVisible: boolean
  readonly shuttingDown: boolean
}

const runningPane = (run: number, process: ProcessRun): InternalPaneLifecycle => ({
  _tag: 'Running',
  run,
  process,
})

const cleaningPane = (
  run: number,
  process: ProcessRun,
  target: PaneTerminalOutcome,
  cleanup: PaneCleanup,
): InternalPaneLifecycle => ({
  _tag: 'Cleaning',
  run,
  process,
  target,
  cleanup,
})

function paneRun(lifecycle: PaneLifecycle | InternalPaneLifecycle) {
  return lifecycle._tag === 'Ready' ? lifecycle.lastRun : lifecycle.run
}

function isActive(lifecycle: PaneLifecycle | InternalPaneLifecycle) {
  return lifecycle._tag !== 'Ready' && !isCleanupFailed(lifecycle)
}

function isCleanupFailed(lifecycle: PaneLifecycle | InternalPaneLifecycle) {
  return lifecycle._tag === 'Cleaning' && lifecycle.cleanup._tag === 'Failed'
}

function updatePane(
  state: ControllerState,
  name: string,
  update: (pane: InternalPane) => InternalPane,
): ControllerState {
  return {
    ...state,
    panes: state.panes.map((pane) => (pane.name === name ? update(pane) : pane)),
  }
}

function findPane(state: ControllerState, name: string) {
  return state.panes.find((pane) => pane.name === name)
}

function toPaneLifecycle(lifecycle: InternalPaneLifecycle): PaneLifecycle {
  switch (lifecycle._tag) {
    case 'Ready':
    case 'Starting':
      return lifecycle
    case 'Running':
      return PaneLifecycle.Running({ run: lifecycle.run })
    case 'Cleaning':
      return PaneLifecycle.Cleaning({
        run: lifecycle.run,
        target: lifecycle.target,
        cleanup: lifecycle.cleanup,
      })
  }
}

function toWorkspaceSnapshot(state: ControllerState): WorkspaceSnapshot {
  return {
    panes: state.panes.map((pane) => ({
      name: pane.name,
      title: pane.title,
      lifecycle: toPaneLifecycle(pane.lifecycle),
    })),
    selected: state.selected,
    mode: state.mode,
    sidebarVisible: state.sidebarVisible,
    shuttingDown: state.shuttingDown,
  }
}

/** Projects a pane lifecycle to its compact TUI status. */
export function renderStatus(lifecycle: PaneLifecycle) {
  switch (lifecycle._tag) {
    case 'Ready':
      switch (lifecycle.outcome._tag) {
        case 'Idle':
          return 'idle'
        case 'Stopped':
          return 'stopped'
        case 'Succeeded':
          return 'succeeded'
        case 'Exited':
          return `failed (${lifecycle.outcome.exitCode})`
        case 'StartFailed':
        case 'RuntimeFailed':
          return 'failed'
      }
    case 'Starting':
      return 'starting'
    case 'Running':
      return 'running'
    case 'Cleaning':
      return lifecycle.cleanup._tag === 'Failed' ? 'failed' : 'stopping'
  }
}

/** Creates a scoped controller that exclusively owns each pane's active process run. */
export const createWorkspaceController = Effect.fn('workspace.controller.make')(function* (
  definitions: readonly WorkspaceDefinition[],
): Effect.fn.Return<WorkspaceController, never, Scope.Scope | ProcessDriver> {
  const driver = yield* ProcessDriver
  const first = definitions[0]
  if (!first) throw new Error('Workspace requires at least one command.')
  const scope = yield* Effect.scope
  const state = yield* SubscriptionRef.make<ControllerState>({
    panes: definitions.map((definition) => ({
      name: definition.name,
      title: definition.title,
      lifecycle: PaneLifecycle.Ready({ lastRun: 0, outcome: PaneOutcome.Idle() }),
    })),
    selected: first.name,
    mode: 'navigation',
    sidebarVisible: true,
    shuttingDown: false,
  })
  const events = yield* Queue.unbounded<WorkspaceEvent>()
  const lifecycle = yield* Semaphore.make(1)
  const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]))
  let initialized = false

  const commandError = (reason: WorkspaceCommandError['reason'], name?: string) =>
    new WorkspaceCommandError({ reason, name })

  const setPaneLifecycle = (name: string, run: number, next: InternalPaneLifecycle) =>
    SubscriptionRef.updateAndGet(state, (current): ControllerState => {
      const pane = findPane(current, name)
      if (!pane || paneRun(pane.lifecycle) !== run) return current
      const updated = updatePane(current, name, () => ({ ...pane, lifecycle: next }))
      return current.selected === name && !isActive(next)
        ? { ...updated, mode: 'navigation' }
        : updated
    })

  const completeRun = (
    name: string,
    run: number,
    process: ProcessRun,
    target: PaneTerminalOutcome,
  ) =>
    Effect.gen(function* () {
      const ownsRun = yield* lifecycle.withPermit(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state)
          const pane = findPane(current, name)
          if (
            !pane ||
            pane.lifecycle._tag === 'Ready' ||
            pane.lifecycle._tag === 'Starting' ||
            pane.lifecycle.run !== run ||
            pane.lifecycle.process !== process
          )
            return false
          if (pane.lifecycle._tag === 'Running')
            yield* setPaneLifecycle(
              name,
              run,
              cleaningPane(run, process, target, PaneCleanup.Pending()),
            )
          return true
        }),
      )
      if (!ownsRun) return
      const cleanup = yield* Effect.result(process.cleanup)
      yield* lifecycle.withPermit(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state)
          const pane = findPane(current, name)
          if (
            !pane ||
            pane.lifecycle._tag !== 'Cleaning' ||
            pane.lifecycle.run !== run ||
            pane.lifecycle.process !== process
          )
            return
          if (Result.isFailure(cleanup)) {
            yield* setPaneLifecycle(
              name,
              run,
              cleaningPane(
                run,
                process,
                pane.lifecycle.target,
                PaneCleanup.Failed({
                  operation: cleanup.failure.operation,
                  processGroupId: cleanup.failure.processGroupId,
                }),
              ),
            )
            return
          }
          yield* setPaneLifecycle(
            name,
            run,
            PaneLifecycle.Ready({ lastRun: run, outcome: pane.lifecycle.target }),
          )
        }),
      )
    })

  const watchRun = (name: string, run: number, process: ProcessRun) =>
    process.awaitExit.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          completeRun(
            name,
            run,
            process,
            PaneOutcome.RuntimeFailed({ operation: error.operation }),
          ),
        onSuccess: (code) =>
          completeRun(
            name,
            run,
            process,
            code === 0
              ? PaneOutcome.Succeeded({ exitCode: 0 })
              : PaneOutcome.Exited({ exitCode: code }),
          ),
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
      if (pane.lifecycle._tag !== 'Ready' && !isCleanupFailed(pane.lifecycle))
        return yield* Effect.fail(commandError('paneAlreadyActive', name))
      if (isCleanupFailed(pane.lifecycle))
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
        const failed = yield* setPaneLifecycle(
          name,
          run,
          PaneLifecycle.Ready({
            lastRun: run,
            outcome: PaneOutcome.StartFailed({ operation: started.failure.operation }),
          }),
        )
        return toWorkspaceSnapshot(failed)
      }
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* setPaneLifecycle(name, run, runningPane(run, started.success))
          yield* Effect.forkIn(watchRun(name, run, started.success), scope)
        }),
      )
      return toWorkspaceSnapshot(yield* SubscriptionRef.get(state))
    })

  const stopLocked = (name: string) =>
    Effect.gen(function* () {
      const snapshot = yield* SubscriptionRef.get(state)
      const pane = findPane(snapshot, name)
      if (!pane) return yield* Effect.fail(commandError('unknownPane', name))
      if (pane.lifecycle._tag === 'Ready' || isCleanupFailed(pane.lifecycle))
        return toWorkspaceSnapshot(snapshot)
      if (pane.lifecycle._tag === 'Starting')
        return yield* Effect.fail(commandError('paneNotRunning', name))
      const run = pane.lifecycle.run
      const process = pane.lifecycle.process
      yield* setPaneLifecycle(
        name,
        run,
        cleaningPane(run, process, PaneOutcome.Stopped(), PaneCleanup.Pending()),
      )
      const cleanup = yield* Effect.result(process.cleanup)
      if (Result.isFailure(cleanup)) {
        const failed = yield* setPaneLifecycle(
          name,
          run,
          cleaningPane(
            run,
            process,
            PaneOutcome.Stopped(),
            PaneCleanup.Failed({
              operation: cleanup.failure.operation,
              processGroupId: cleanup.failure.processGroupId,
            }),
          ),
        )
        return toWorkspaceSnapshot(failed)
      }
      const stopped = yield* setPaneLifecycle(
        name,
        run,
        PaneLifecycle.Ready({ lastRun: run, outcome: PaneOutcome.Stopped() }),
      )
      return toWorkspaceSnapshot(stopped)
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
        return toWorkspaceSnapshot(yield* SubscriptionRef.get(state))
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
        if (command.type === 'resize' && pane.lifecycle._tag !== 'Running')
          return toWorkspaceSnapshot(snapshot)
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
        if (command.type === 'write') yield* pane.lifecycle.process.write(command.bytes)
        else yield* pane.lifecycle.process.resize(command.size)
        return toWorkspaceSnapshot(yield* SubscriptionRef.get(state))
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
            const pane = stopped.panes.find((candidate) => candidate.name === command.name)
            if (pane && isCleanupFailed(pane.lifecycle))
              return yield* Effect.fail(commandError('paneCleanupUnresolved', command.name))
            return yield* startLocked(command.name, command.size)
          }
          case 'select':
            if (!findPane(snapshot, command.name))
              return yield* Effect.fail(commandError('unknownPane', command.name))
            return toWorkspaceSnapshot(
              yield* SubscriptionRef.updateAndGet(state, (current): ControllerState => ({
                ...current,
                selected: command.name,
                mode: 'navigation',
              })),
            )
          case 'enterInput': {
            const pane = findPane(snapshot, command.name)
            if (!pane || snapshot.selected !== command.name || pane.lifecycle._tag !== 'Running')
              return yield* Effect.fail(commandError('paneNotRunning', command.name))
            return toWorkspaceSnapshot(
              yield* SubscriptionRef.updateAndGet(state, (current): ControllerState => ({
                ...current,
                mode: 'input',
              })),
            )
          }
          case 'leaveInput':
            return toWorkspaceSnapshot(
              yield* SubscriptionRef.updateAndGet(state, (current): ControllerState => ({
                ...current,
                mode: 'navigation',
              })),
            )
          case 'setSidebarVisible':
            return toWorkspaceSnapshot(
              yield* SubscriptionRef.updateAndGet(state, (current) => ({
                ...current,
                sidebarVisible: command.visible,
              })),
            )
        }
      }),
    )
  }

  const shutdownEffect = lifecycle.withPermit(
    Effect.gen(function* () {
      yield* SubscriptionRef.update(state, (current): ControllerState => ({
        ...current,
        mode: 'navigation',
        shuttingDown: true,
      }))
      const failures: CleanupFailure[] = []
      const ownedPanes = (yield* SubscriptionRef.get(state)).panes.filter(
        (
          pane,
        ): pane is InternalPane & {
          readonly lifecycle: Extract<
            InternalPaneLifecycle,
            { readonly _tag: 'Running' | 'Cleaning' }
          >
        } => pane.lifecycle._tag === 'Running' || pane.lifecycle._tag === 'Cleaning',
      )
      for (const ownedPane of ownedPanes) {
        const { name } = ownedPane
        const owned = ownedPane.lifecycle
        const target = owned._tag === 'Cleaning' ? owned.target : PaneOutcome.Stopped()
        yield* setPaneLifecycle(
          name,
          owned.run,
          cleaningPane(owned.run, owned.process, target, PaneCleanup.Pending()),
        )
        const cleanup = yield* Effect.result(owned.process.cleanup)
        if (Result.isFailure(cleanup)) {
          failures.push({
            name,
            run: owned.run,
            operation: cleanup.failure.operation,
            processGroupId: cleanup.failure.processGroupId,
            target,
          })
          yield* setPaneLifecycle(
            name,
            owned.run,
            cleaningPane(
              owned.run,
              owned.process,
              target,
              PaneCleanup.Failed({
                operation: cleanup.failure.operation,
                processGroupId: cleanup.failure.processGroupId,
              }),
            ),
          )
        } else {
          yield* setPaneLifecycle(
            name,
            owned.run,
            PaneLifecycle.Ready({ lastRun: owned.run, outcome: target }),
          )
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
    snapshots: SubscriptionRef.changes(state).pipe(Stream.map(toWorkspaceSnapshot)),
    events: Stream.fromQueue(events),
    snapshot: SubscriptionRef.get(state).pipe(Effect.map(toWorkspaceSnapshot)),
    initialize,
    dispatch,
    shutdown,
  }
})
