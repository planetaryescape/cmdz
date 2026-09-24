# Scoped process cleanup and shutdown reporting

## Summary

Keep the workspace controller as the owner of process runs and its Effect scope as the final cleanup boundary. Make the POSIX process-group release verify the _group_, not merely its leader, and make view setup failures use the same typed shutdown path as a normal quit. Preserve explicit, retryable cleanup: a failed release must remain observable as `PaneCleanup.Failed` and must not be mistaken for a closed resource.

## Context / Current State

- `terminalSession` acquires the OpenTUI renderer with `Effect.acquireRelease`; `runWorkspace` and `renderWorkspaceView` run inside `Effect.scoped`.
- `createWorkspaceController` registers `shutdown` with `Effect.addFinalizer`, and forks each process watcher into the controller scope. Its `ProcessRun.cleanup` operation is serialized, retryable, and reflected in pane state. The production driver is in `@cmdz/cli`; `@cmdz/core` has no Bun or OpenTUI dependency.
- `startPty` sends `SIGTERM` to the process group, waits up to three seconds for `child.exited`, and sends `SIGKILL` only if that _leader_ has not exited. A TERM-ignoring group member can survive a promptly exiting leader. The README currently promises a force-kill of remaining members, which the implementation does not establish.
- `renderWorkspaceView` wraps only its action loop with `Effect.onExit(() => runtime.shutdown)`. If `runtime.initialize` or subsequent setup fails, the controller scope still runs its shutdown finalizer, but that finalizer logs and absorbs `WorkspaceShutdownError`; the CLI cannot format its per-pane diagnostic in that path.
- The public driver contract is not scope-typed. In production it is called only by the scoped controller. Direct driver calls in tests clean up explicitly; adding a scoped requirement to `ProcessDriver.start` would change the internal package API and its fake.

## Goals

1. A successful release means the owned process group is no longer present, even when its leader exited before its descendants.
2. A failed release retains the run for explicit stop retry or controller shutdown and reports a typed cleanup failure with its process group ID.
3. A failure during view initialization or later view execution attempts shutdown and exposes `WorkspaceShutdownError` to `main.ts` when cleanup fails.
4. Session interruption still closes listeners and renderer after process cleanup; natural exit, stop, restart, and repeated shutdown keep their current observable behavior.

## Non-Goals

- Managing descendants that deliberately leave the spawned process group.
- New process supervision, platform support beyond the existing Bun/POSIX adapter, persistence, or UI state variants.
- Introducing a second process-owner service or replacing the controller state machine.

## Invariants and Design Constraints

- One controller owns each active `ProcessRun`; only a successful cleanup permits `Ready`/restart. A failed attempt remains retryable.
- `ProcessRun.cleanup` coalesces concurrent calls and is idempotent after success; a failure does not mark it cleaned.
- Cleanup tries every pane on shutdown and aggregates failures; `shutdown` remains memoized.
- An Effect scope guarantees a finalizer is **attempted**, not that an OS release succeeds. A failed release must not be hidden by closing a scope.
- Group-existence checks are platform operations; only `ESRCH` means absent. Other errors are typed cleanup failures. A bounded verification wait must not loop forever during signal interruption.
- Preserve existing spans (`process.release`, `terminal.release`, `terminal.session`), safe logs, and CLI shutdown diagnostics. Do not log command text or environment values.

## Alternatives Considered

### Option 1: Scoped `ProcessDriver.start` with one workspace scope

```ts
interface ProcessDriverService {
  readonly start: (
    request: ProcessStartRequest,
  ) => Effect.Effect<ProcessRun, ProcessStartError, Scope.Scope>
}
```

`Effect.acquireRelease` would register `run.cleanup` in the workspace scope. This prevents an unmanaged direct caller but does not close a run at stop/restart: the workspace scope lasts longer. Its finalizer can also retry a failed cleanup _after_ the controller has already reported a failure, making the reported state ambiguous. Callers, the recording fake, and finalizer ordering would all change.

### Option 2: One child `Scope` per process run

```ts
interface OwnedRun {
  readonly run: ProcessRun
  readonly scope: Scope.Scope
}
```

The controller would create a scope for each start and close it at stop, exit, or shutdown. This aligns scope lifetime with the process lifetime, but `Scope.close` does not preserve the existing typed, retryable `ProcessCleanupError` contract on a failed release. Retaining failed child scopes, preventing duplicate finalizers, and ordering parent shutdown against their closure would duplicate the existing ownership state machine. Defer until there is a concrete second production driver caller or a clear need to remove explicit cleanup.

### Option 3: Keep controller ownership and strengthen the current release path (recommended)

No public contract change. `ProcessRun.cleanup` remains the typed release operation; the controller scope remains the fallback lifetime boundary. Improve group verification in the Bun adapter and widen the view's explicit shutdown handler to cover initialization. This changes the fewest moving parts and preserves retry and diagnostic semantics.

## Recommendation

Take Option 3. In particular, do not add a second best-effort PTY finalizer that races or retries after the controller has declared failure. The current controller finalizer already owns cleanup on interruption and unexpected exit. Make its adapter's success claim truthful, and make the explicit shutdown path cover every point after process initialization begins.

## Proposed Design

### Domain Model and Types

Retain `PaneLifecycle`, `PaneCleanup`, `CleanupFailure`, `WorkspaceShutdownError`, `ProcessRun`, and `ProcessDriverService`. No new exported domain type, DTO, codec, or service is needed. Keep `ProcessCleanupError.operation` stable in shape; use a distinct safe operation label for group verification failure so the existing diagnostic is actionable.

### Types, Interfaces, and APIs

```ts
interface ProcessRun {
  readonly awaitExit: Effect.Effect<number, ProcessRuntimeError>
  readonly cleanup: Effect.Effect<void, ProcessCleanupError>
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, ProcessIoError>
  readonly resize: (size: TerminalSize) => Effect.Effect<void, ProcessIoError>
}

interface WorkspaceController {
  readonly shutdown: Effect.Effect<void, WorkspaceShutdownError>
  // All other existing members unchanged.
}

type GroupPresence = 'present' | 'absent'

function groupPresence(pgid: number): Effect.Effect<GroupPresence, ProcessCleanupError>

function releaseGroup(
  pgid: number,
  awaitLeader: Effect.Effect<number, ProcessCleanupError>,
): Effect.Effect<void, ProcessCleanupError>
```

`groupPresence` and `releaseGroup` are private to `pty-process.ts`; the signatures express the expected failure channel, not a new public seam. `releaseGroup` must retain the existing three-second TERM grace period and bounded KILL/verification behavior. Exact post-KILL deadline should be chosen from the current PTY shutdown budget during implementation and documented in the adapter test, not introduced as user configuration.

### Seams, Boundaries, Adapters, and Implementations

- `@cmdz/core/process-driver.ts`: existing behavior-shaped seam. It knows about a process run and typed I/O/cleanup errors, never POSIX signals or Bun terminals.
- `@cmdz/cli/pty-process.ts`: existing external adapter. It owns `Bun.spawn`, process-group signaling/probing, `child.exited`, terminal draining/closing, and translation of OS failures to `ProcessCleanupError`.
- `@cmdz/core/workspace.ts`: existing service module and scope owner. It owns pane transitions, retries, shutdown aggregation, and process watcher fibers; no platform probing.
- `@cmdz/tui/workspace-view.ts`: inbound UI adapter. It owns the listener scope and ensures initialization plus the action loop both exit through `runtime.shutdown`.
- `@cmdz/cli/main.ts`: existing final diagnostic boundary. No new response shape or CLI flag.

## Call Stacks and Data Flow

### Current / Old Flow

```txt
SIGINT/SIGTERM or q
  -> main.ts AbortSignal / UI quit
  -> terminalSession Effect.scoped
  -> runWorkspace Effect.scoped
  -> renderWorkspaceView action-loop onExit -> controller.shutdown
  -> ProcessRun.cleanup -> SIGTERM(group) -> await leader
  -> if leader exited: close PTY and report success (group not checked)
  -> controller pane Ready -> renderer release

initialize failure
  -> skips action-loop onExit
  -> controller scope finalizer -> shutdown error logged and absorbed
  -> CLI sees original failure rather than structured cleanup failure
```

### Proposed / New Flow

```txt
stop / natural exit / restart / quit / signal
  -> controller transition or controller.shutdown
  -> ProcessRun.cleanup under existing semaphore
  -> SIGTERM(-pgid)
  -> bounded wait for leader and check group presence
  -> if group persists: SIGKILL(-pgid), bounded check for group absence
  -> wait for leader if needed; bounded PTY drain; close terminal
  -> success: pane Ready, restart permitted; scope eventually closes

renderer events -> view setup -> runtime.initialize -> action loop
  -> onExit(runtime.shutdown) surrounding initialize + loop
  -> view scope releases listeners/subscription fibers
  -> controller scope finalizer reuses memoized shutdown
  -> terminal scope destroys renderer
  -> main.ts formats WorkspaceShutdownError if present
```

### Failure Flow

```txt
signal/probe/verify/drain fails
  -> ProcessCleanupError { operation, processGroupId }
  -> controller Cleaning { cleanup: Failed(...) }
  -> stop again: retry same run
  -> shutdown: retry every unresolved run, aggregate CleanupFailure[]
  -> WorkspaceShutdownError -> formatShutdownDiagnostic -> stderr + nonzero exit
```

Ensure a failed probe is not treated as an absent group. The existing `Effect.ensuring` still closes the terminal on cleanup failure; preserve or explicitly reconsider this during the implementation slice, since retry currently relies on the PID/group rather than an open terminal. If `runtime.initialize` itself fails while cleanup also fails, preserve the cleanup diagnostic without silently discarding the original initialization cause; verify Effect's `onExit` cause composition against the pinned `effect@4.0.0-rc.112` before choosing the exact combinator.

### Retry / Cancellation / Idempotency Flow

`startPty` remains uninterruptible across spawn and handoff, so a successful spawn cannot escape without becoming a controller-owned run. The controller's shutdown effect remains uninterruptible and cached. `ProcessRun.cleanup` stays serialized under its semaphore; only after confirmed group absence and PTY drain does it set `cleaned = true`. Failed cleanup retains ownership and can be retried. Scope closure attempts shutdown even if the view fails before explicit shutdown is reached.

### Observability Flow

Keep the existing `process.release` span and `Workspace cleanup failed` log. Annotate new probe/escalation failures with safe operation and process group ID through the existing typed error; retain `terminal.session` exit classification and the CLI's structured shutdown message. The group probe should not emit a warning for the normal `ESRCH` case.

## Files to Add / Change / Delete

| File                                     | Responsibility                                                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/pty-process.ts`        | Verify the entire group after TERM, escalate when any member remains, bound post-KILL verification, preserve retryable typed failures and PTY drain. |
| `packages/tui/src/workspace-view.ts`     | Cover initialization and the action loop with explicit shutdown reporting while preserving listener and fiber scope ordering.                        |
| `packages/cli/src/pty-process.test.ts`   | Real Bun/POSIX adapter behavior when leader exits but a group member ignores TERM; failed-probe/timeout behavior where reproducible.                 |
| `packages/core/src/workspace.test.ts`    | Existing fake-driver stop, retry, interrupt, shutdown, and aggregation coverage; extend only if changed behavior reveals a gap.                      |
| `packages/cli/src/cleanup-retry.test.ts` | View-level initialization failure plus cleanup failure through the recording driver and typed exit, if this is the least-coupled test entrypoint.    |
| `README.md`                              | Align the process-group cleanup description with the verified behavior and bounded failure case.                                                     |

No new production files, package dependencies, schema, database changes, or deletions are expected.

## RGR TDD Test Plan

1. **Leader-exit tracer bullet.** Red: a real PTY run spawns a child that stays in its group and ignores TERM while its leader exits; cleanup must not succeed with that child alive. Green: check group presence after leader exit and escalate to KILL. Refactor the probe/release flow without changing the public driver seam. Test teardown must force-kill any recorded test group if Red leaves it behind.
2. **Bounded failure.** Red: a group that cannot be confirmed absent returns `ProcessCleanupError` with its PGID rather than `cleaned = true` or an indefinite wait. Green: bounded post-KILL verification and typed failure; use a controlled adapter boundary or representative OS behavior, not a private-helper-only assertion. Keep stop retry available.
3. **Initialization shutdown diagnostic.** Red: pass the view a test `WorkspaceController` whose `initialize` delegates to the real controller, then returns a typed initialization failure after its autostart has acquired a run. Use the recording driver to fail that run's cleanup; assert the exit exposes `WorkspaceShutdownError` and cleanup was attempted. Green: expand `onExit` to cover initialization. Check that the view's listeners are removed and the controller finalizer reuses the memoized shutdown.
4. **Regression checks.** Run existing real PTY interruption, TERM-to-KILL, attachment failure, idempotent cleanup, controller cleanup-retry/aggregation, and compiled-binary quit/SIGTERM smoke tests. Then `bun run check` and `bun run test:binary` on the supported POSIX environment. Do not add unit tests for framework route/page files; none are involved.

## Risks and Open Questions

- **Production risk:** Changed group probing can lengthen stop/quit by a bounded interval and can turn a previously reported success into a cleanup failure when descendants remain. That is intentional and needs explicit approval before implementation. A smaller first step is the real-PTY regression test plus group verification only; keep any broader driver API change separate.
- **OS semantics:** Confirm whether the supported macOS/Linux test environments ever retain a zombie process-group member long enough that `kill(-pgid, 0)` reports presence after KILL. A bounded failure is preferable to a false success; tune the verification deadline from measured runs.
- **Effect cause composition:** Confirm `Effect.onExit` behavior for an initialization failure followed by a failing shutdown in the pinned release candidate, so the original failure is not lost and the CLI still finds `WorkspaceShutdownError`.
- **Scope-typed driver API:** Not part of this refactor. Revisit only if another production caller starts PTYs outside `createWorkspaceController`; the present caller already supplies a scoped owner and explicit retryable cleanup.
