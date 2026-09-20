# Headless workspace extraction

## Summary

Extract one headless workspace controller that owns command lifecycle, run identity, UI state, process coordination, and shutdown policy. Keep POSIX PTY mechanics and OpenTUI rendering behind adapters. Complete the work in one implementation loop and one pull request.

This spec consolidates the remaining wayfinding work:

| GitHub item                          | Disposition                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| #5, fake process adapter and harness | Completed by merged PR #11. Its fake becomes the starting evidence for the production seam. |
| #7, verification matrix              | Defined in this spec and completed by the acceptance matrix below.                          |
| #4, extraction and rollout plan      | Replaced by the big-bang implementation loop below.                                         |
| #1, parent map                       | Closes when every acceptance criterion in this spec passes on all supported CI targets.     |

The implementation loop must not create replacement planning issues. A discovered blocker is recorded in the implementation PR, resolved there when it is in scope, or explicitly moved to a new issue only when it is outside this spec.

## Context / Current State

`src/process-workspace.ts` currently owns two responsibilities:

1. OpenTUI construction, input translation, focus, layout, and rendering.
2. Process registry state, run generations, start, stop, restart, exit handling, and scoped fibers.

`src/workspace-core.ts` already models immutable workspace snapshots and rejects stale process events, but production does not use it. It accepts both user commands and adapter lifecycle events through one public `dispatch` union. It does not own process execution or shutdown.

`src/pty-process.ts` already owns the real POSIX boundary:

- detached process-group spawn;
- PTY input, output, and resize;
- SIGTERM, three-second grace, SIGKILL, and exit wait;
- one-second output drain;
- PTY closure;
- process spans and safe lifecycle logs.

`ProcessPane` currently mixes OpenTUI terminal state with process handles, fibers, run identity, and lifecycle status. The test suite already has four useful levels:

- pure headless state tests;
- OpenTUI in-memory renderer tests;
- real PTY and process-group tests;
- compiled-binary pseudoterminal smoke tests on macOS and Linux, arm64 and x64.

Merged PR #11 provides a deterministic test-scoped fake for process input, output, resize, startup failure, stop, restart, stale events, and shutdown.

## Goals

- Make the headless workspace controller the single source of truth for process lifecycle and UI state.
- Keep OpenTUI types out of the headless controller.
- Keep Bun PTY and POSIX process-group details out of the controller and renderer.
- Preserve every behavior in `docs/compatibility-guardrails.md`.
- Make cleanup failure semantics deterministic under a fake adapter and representative under the real PTY adapter.
- Preserve existing telemetry names and safe fields unless a more precise lifecycle field is required.
- Complete extraction through one coordinated big-bang cutover without a compatibility flag or parallel production path.

## Non-Goals

- A user-facing headless CLI.
- Windows process supervision.
- New navigation, search, copy, split panes, config reload, or cross-run history.
- A new terminal parser or PTY dependency.
- Changes to configuration syntax.
- Automatic crash restart.
- Cleanup of descendants that deliberately leave the owned POSIX process group.
- Release, packaging, signing, or publishing changes.

## Invariants

1. One command has at most one active run.
2. Every run has a monotonically increasing generation within its command.
3. Events from an older or unknown generation cannot change the current run.
4. Restart finishes cleanup of the current run before starting the next generation.
5. Manual stop preserves terminal output and ends in `stopped`.
6. Restart creates a fresh terminal screen for the next generation.
7. Natural exit preserves output, never restarts automatically, and records the exit code.
8. Input reaches only the selected running command while input mode is active.
9. Terminal protocol responses reach their current run even when its pane is in the background.
10. Resize applies to every active terminal, including background panes.
11. App shutdown attempts cleanup for every active run, even after one cleanup failure.
12. Terminal restoration runs after workspace completion, interruption, or failure.
13. An unresolved process group identifies its process group ID in a safe stderr diagnostic and makes shutdown unsuccessful.
14. Child output stays as opaque bytes until OpenTUI's embedded terminal handles it.
15. Process environment values, command input, and child output never enter cmdz telemetry.

## Design Constraints

- Keep Effect as the lifecycle and resource-management runtime.
- Keep Bun's PTY as the production process adapter.
- Keep OpenTUI's `EmbeddedTerminalRenderable` as the terminal model and renderer.
- Use the existing Bun test runner, strict TypeScript checks, Oxlint, and Oxfmt.
- Do not use module mocks, method spies, sleeps, or retrying tests.
- Preserve `/bin/sh -c` command execution and current cwd/environment semantics.
- Use one direct production adapter and one recording fake through the same process-driver contract.

## Alternatives Considered

### Option 1: Big-bang replacement

Replace `processWorkspace`, `ProcessPane`, and `runPty` in one pass with a new controller, process service, and renderer.

Tradeoffs:

- Lowest temporary duplication.
- One clear ownership transition with no intermediate production architecture.
- Highest concentrated regression risk across input, focus, resize, cleanup, and terminal restoration.
- Requires the full fake contract and compatibility matrix to be green before the production cutover is reviewable.
- Relies on the four native CI jobs as a hard merge gate.

### Option 2: Vertical strangler extraction

Deepen the existing workspace core behind an injected process-driver seam, then move one behavior slice at a time from `processWorkspace` into it. Keep the existing PTY and OpenTUI implementations, but narrow each to its boundary responsibility. Delete old lifecycle ownership only after parity tests pass.

Tradeoffs:

- Small temporary duplication while each vertical slice moves.
- Every slice can be proven through the public controller interface and existing integration tests.
- Preserves production behavior while changing ownership.
- Gives cleanup and stale-event semantics one source of truth.

### Option 3: Verification-only hardening

Leave production ownership in `processWorkspace` and use `workspace-core.ts` only as a reference model for tests.

Tradeoffs:

- Smallest immediate change.
- Leaves two lifecycle models that can drift.
- Does not achieve the headless core goal.
- Fake-adapter evidence would not exercise the production orchestration contract.

## Recommendation

Use Option 1. Build and prove the complete replacement behind the headless contracts, then switch all production ownership in one coordinated cutover. Do not retain the old orchestration as a fallback or merge an intermediate dual-path state.

The workspace controller becomes a deep Service Module. It accepts user intent, coordinates a process driver, publishes immutable snapshots and opaque output events, and owns shutdown policy. The PTY adapter and OpenTUI adapter remain narrow External Adapter Modules. The fake contract tests and existing compatibility surfaces control the risk of the big-bang change.

Do not add an Effect `Context.Service` or `Layer` solely for this extraction. The application has one workspace instance, and a constructor argument is already a sufficient explicit seam. Continue to use Effect scopes for acquired resources and fibers.

## Proposed Design

### Ownership

```diagram
┌──────────────────────┐  user commands   ┌────────────────────────┐
│ OpenTUI workspace UI │─────────────────▶│ Headless workspace     │
│                      │◀─────────────────│ controller             │
│ render + input only  │ snapshots/events │ state + lifecycle      │
└──────────────────────┘                  └───────────┬────────────┘
                                                     │ process driver
                                                     ▼
                                         ┌────────────────────────┐
                                         │ Bun PTY adapter        │
                                         │ process group + PTY    │
                                         │ drain + close          │
                                         └────────────────────────┘
```

The controller knows command definitions, lifecycle state, selected identity, input mode, sidebar visibility, run controls, and cleanup outcomes. It does not know OpenTUI renderables, terminal cells, ANSI parsing, Bun terminals, PIDs, process-group signaling, or host-terminal restoration.

The OpenTUI adapter knows terminal renderables, key and mouse events, focus, help visibility, layout, and status projections. It does not spawn, signal, await, or classify processes.

The PTY adapter knows `/bin/sh -c`, cwd, environment, PTY dimensions, raw bytes, process groups, grace periods, drain, and closure. It does not know selection, input mode, sidebar state, or OpenTUI.

## Domain Model and Types

```ts
export type RunId = number

export type PaneOutcome =
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'Stopped' }
  | { readonly _tag: 'Succeeded'; readonly exitCode: 0 }
  | { readonly _tag: 'StartFailed'; readonly operation: string }
  | { readonly _tag: 'RuntimeFailed'; readonly operation: string }
  | { readonly _tag: 'Exited'; readonly exitCode: number }

export type PaneLifecycle =
  | { readonly _tag: 'Ready'; readonly lastRun: RunId; readonly outcome: PaneOutcome }
  | { readonly _tag: 'Starting'; readonly run: RunId }
  | { readonly _tag: 'Running'; readonly run: RunId }
  | {
      readonly _tag: 'Cleaning'
      readonly run: RunId
      readonly target: Exclude<PaneOutcome, { readonly _tag: 'Idle' | 'StartFailed' }>
      readonly cleanup:
        | { readonly _tag: 'Pending' }
        | {
            readonly _tag: 'Failed'
            readonly operation: string
            readonly processGroupId?: number
          }
    }

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
```

The private controller state adds the owned `ProcessRun` directly to `Running` and `Cleaning`; snapshots project it away. This makes resource ownership part of the state machine rather than a parallel map. `Cleaning.target` records the terminal outcome before cleanup begins, so a failed attempt can retain both ownership and the exact result to restore.

The OpenTUI adapter projects `PaneLifecycle` to text:

```ts
function renderStatus(lifecycle: PaneLifecycle): string
```

The projection returns `idle`, `starting`, `running`, `stopping`, `stopped`, `succeeded`, `failed (<code>)`, or `failed` for start, runtime, and cleanup failures. Natural and runtime completion visibly enter `stopping` while PTY resources are being cleaned.

## Types, Interfaces, and APIs

### Controller commands

Only user or renderer intent is public. Process lifecycle events are private to the controller. `write` distinguishes user input from terminal protocol responses because OpenTUI must answer terminal queries from background panes without letting user keystrokes reach them.

```ts
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
    }
  | { readonly type: 'resize'; readonly name: string; readonly size: TerminalSize }
  | { readonly type: 'setSidebarVisible'; readonly visible: boolean }

export interface TerminalSize {
  readonly columns: number
  readonly rows: number
}

export type WorkspaceEvent =
  | { readonly type: 'resetTerminal'; readonly name: string; readonly run: RunId }
  | {
      readonly type: 'output'
      readonly name: string
      readonly run: RunId
      readonly bytes: Uint8Array
    }

export interface WorkspaceController {
  readonly snapshots: Stream.Stream<WorkspaceSnapshot>
  readonly events: Stream.Stream<WorkspaceEvent>
  readonly snapshot: Effect.Effect<WorkspaceSnapshot>
  readonly initialize: (
    initialSizes: Readonly<Record<string, TerminalSize>>,
  ) => Effect.Effect<WorkspaceSnapshot, WorkspaceCommandError>
  readonly dispatch: (
    command: WorkspaceCommand,
  ) => Effect.Effect<WorkspaceSnapshot, WorkspaceCommandError>
  readonly shutdown: Effect.Effect<void, WorkspaceShutdownError>
}

export declare const makeWorkspaceController: (
  definitions: readonly ProcessDefinition[],
  driver: ProcessDriver,
) => Effect.Effect<WorkspaceController, never, Scope.Scope>
```

Construction registers scoped fallback cleanup but does not autostart. The OpenTUI adapter subscribes to snapshots and events, then calls `initialize` once with every pane's current dimensions. Initialization applies the definitions' autostart policy. Headless tests follow the same sequence. This prevents startup output from racing event subscription without moving renderer dimensions into the controller.

`shutdown` is the only lifetime-ending API. It is uninterruptible after cleanup begins, idempotent, and memoizes its result. `terminalSession` invokes it for normal quit, renderer failure, and interruption before the controller scope closes. The scope finalizer provides a fallback call. Unknown command names and illegal user commands are typed expected failures. Late adapter events are ignored, not surfaced as command failures.

```ts
export type WorkspaceCommandError =
  | UnknownPane
  | MissingTerminalSize
  | PaneNotRunning
  | PaneAlreadyActive
  | PaneCleanupUnresolved
  | ProcessIoError
  | WorkspaceAlreadyInitialized
  | WorkspaceShuttingDown

export interface CleanupFailure {
  readonly name: string
  readonly run: RunId
  readonly operation: string
  readonly processGroupId?: number
  readonly target: Exclude<PaneOutcome, { readonly _tag: 'Idle' | 'StartFailed' }>
}

export interface WorkspaceShutdownError {
  readonly _tag: 'WorkspaceShutdownError'
  readonly failures: readonly CleanupFailure[]
}
```

### Process driver seam

```ts
export interface ProcessStartRequest {
  readonly name: string
  readonly run: RunId
  readonly command: readonly [string, ...string[]]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly size: TerminalSize
  readonly output: (bytes: Uint8Array) => void
}

export interface ProcessRun {
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, ProcessIoError>
  readonly resize: (size: TerminalSize) => Effect.Effect<void, ProcessIoError>
  readonly awaitExit: Effect.Effect<number, ProcessRuntimeError>
  readonly cleanup: Effect.Effect<void, ProcessCleanupError>
}

export interface ProcessDriver {
  readonly start: (request: ProcessStartRequest) => Effect.Effect<ProcessRun, ProcessStartError>
}
```

`ProcessRun.cleanup` is safe to call repeatedly and deduplicates concurrent attempts. It memoizes success, but a failed stop attempt can be retried during final shutdown. It owns SIGTERM, grace timeout, SIGKILL, exit wait, drain, and PTY close. A partial `start` failure performs any required cleanup before returning `ProcessStartError`. `ProcessCleanupError` carries a safe unresolved process-group ID when applicable. The controller may report that value but never signals or otherwise acts on it.

The production driver wraps the existing `runPty` behavior. The recording fake implements the same interface and exposes test-only records for output, input, dimensions, failures, and cleanup attempts.

## Seams, Boundaries, Adapters, and Implementations

### Headless controller

- Owns the command registry and immutable state transitions.
- Owns one active `ProcessRun` and waiter fiber per active pane.
- Serializes lifecycle commands through one Effect queue.
- Routes input and resize against the current run without waiting behind another pane's cleanup.
- Converts process completion into private generation-checked events.
- Emits output only when the event generation is current.
- Attempts every active cleanup during shutdown and aggregates failures.
- Does not retain terminal output bytes.
- Retains the process-run handle after failed cleanup so final shutdown can retry it.
- Keeps a pane with unresolved cleanup unavailable for start or restart while other panes remain usable.

### Bun PTY adapter

- Reuses the current `ProcessError` classification, split into start, I/O, runtime, and cleanup errors only where callers handle them differently.
- Preserves `process.run` and `process.release` spans.
- Preserves safe `command.name`, process PID, and exit-code fields.
- Never logs command output, input bytes, environment values, or command strings.
- Treats missing groups during signaling as already cleaned up.

### OpenTUI adapter

- Maps keys and mouse events to `WorkspaceCommand`.
- Subscribes to snapshots for status, ordering, selection, mode, and sidebar visibility.
- Consumes the ordered event stream serially, resetting a terminal before applying any output for that run.
- Recreates the pane terminal on `resetTerminal`.
- Reports terminal dimensions through start, restart, and resize commands.
- Marks writes from OpenTUI's `response` source as `terminalResponse` and all focused keystrokes or paste as `user`.
- Keeps help-modal state local because it is renderer-only and does not affect process lifecycle.

### Application composition

`terminalSession` constructs the renderer, PTY driver, controller, and OpenTUI adapter in one Effect scope. The OpenTUI adapter subscribes before controller initialization. `terminalSession` runs controller shutdown on every workspace exit. Renderer release remains outside controller shutdown so host-terminal restoration always runs after workspace success, interruption, or failure.

## Call Stacks and Data Flow

### Current / Old Flow

```text
OpenTUI key
  -> processWorkspace Action queue
  -> mutable ProcessPane status/run/fiber
  -> runPty
  -> Bun PTY/process group
  -> callback mutates ProcessPane/OpenTUI terminal
```

### Proposed / New Flow

#### Start

```text
OpenTUI Enter
  -> WorkspaceCommand.start(name, size)
  -> controller validates idle/completed lifecycle
  -> controller allocates next RunId
  -> snapshot: Starting
  -> WorkspaceEvent.resetTerminal
  -> ProcessDriver.start(ProcessStartRequest)
  -> controller registers ProcessRun
  -> snapshot: Running
  -> waiter fiber awaits ProcessRun.awaitExit
```

#### Output

```text
Bun PTY bytes
  -> ProcessStartRequest.output(bytes)
  -> private event(name, run, bytes)
  -> generation check
  -> WorkspaceEvent.output
  -> OpenTUI EmbeddedTerminalRenderable.write(bytes)
```

#### Input and resize

```text
OpenTUI input/resize
  -> WorkspaceCommand.write/resize
  -> user write: selected + input-mode + current-running validation
  -> terminal response: named + current-running validation
  -> current ProcessRun.write/resize
  -> Bun Terminal
```

#### Stop and restart

```text
WorkspaceCommand.stop/restart
  -> snapshot: Cleaning(target = Stopped, cleanup = Pending)
  -> current ProcessRun.cleanup
  -> wait for cleanup completion
  -> snapshot: Ready(outcome = Stopped)
  -> restart only: dispatch next start with RunId + 1
```

#### Natural exit

```text
ProcessRun.awaitExit
  -> exit code
  -> generation check
  -> snapshot: Cleaning(target = Succeeded | Exited | RuntimeFailed)
  -> cleanup PTY resources; explicit manual stop may retarget to Stopped
  -> snapshot: Ready(outcome = target)
  -> selected pane leaves input mode
```

### Failure Flow

```text
ProcessDriver.start failure
  -> adapter cleans partial resources
  -> controller verifies generation
  -> snapshot: Ready(StartFailed)
  -> other panes continue

single-pane cleanup failure
  -> snapshot: Cleaning(target, Failed)
  -> controller retains the ProcessRun and exact target outcome
  -> affected pane cannot start again
  -> other panes remain usable

shutdown cleanup failures
  -> attempt every active pane
  -> aggregate CleanupFailure values
  -> controller.shutdown fails with WorkspaceShutdownError
  -> terminalSession scope releases renderer
  -> main prints safe group IDs and manual cleanup guidance
  -> exit code 1
```

### Cancellation and Idempotency Flow

- Repeated start on an active pane returns `PaneAlreadyActive` and never allocates a run.
- Start after unresolved cleanup returns `PaneCleanupUnresolved` and cannot create an overlapping process group.
- Repeated stop after completion is a no-op snapshot return.
- Concurrent cleanup calls share one attempt; cleanup after success is a no-op; cleanup after failure can retry.
- OS SIGINT and SIGTERM interrupt `terminalSession`; exit handling invokes controller shutdown before renderer release.
- Concurrent or repeated `shutdown` calls await the same memoized result.
- Old output, exit, failure, and cleanup completion events are ignored by generation.

### Observability Flow

```text
terminal.session
  -> process.workspace
  -> command.run { command.name }
  -> process.run { process.pid, process.exitCode }
  -> process.release
```

Keep existing span names for trace continuity. Add `command.run` as a numeric field where useful. Cleanup errors report a stable operation and process group ID only. No raw cause, environment, input, or output is serialized.

## Files to Add / Change / Delete

| File                                 | Action and responsibility                                                                                                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workspace-core.ts`              | Change into the production headless controller with typed lifecycle, commands, events, process-driver coordination, and aggregated shutdown.                                      |
| `src/workspace-core.test.ts`         | Change into behavior tests through `WorkspaceController` and the recording fake.                                                                                                  |
| `src/process-driver.ts`              | Add the process-driver and process-run contracts if keeping them in `workspace-core.ts` makes its public surface harder to read. Do not create this file as a pass-through alias. |
| `src/pty-process.ts`                 | Adapt existing Bun PTY ownership to the process-driver contract and typed cleanup outcomes.                                                                                       |
| `src/pty-process.test.ts`            | Add real process-group escalation, drain/closure, and adapter-contract coverage.                                                                                                  |
| `src/process-workspace.ts`           | Remove lifecycle orchestration. Keep OpenTUI construction, input translation, event subscription, and rendering.                                                                  |
| `src/process-pane.ts`                | Rename to `terminal-pane.ts` or reduce in place to terminal-renderable ownership only. Remove PTY, fiber, run, and lifecycle fields.                                              |
| `src/process-workspace.test.ts`      | Preserve the integrated OpenTUI plus real-PTY behavior test after rewiring.                                                                                                       |
| `src/testing/workspace-core.test.ts` | Delete after its fake behavior moves behind the production process-driver seam in `workspace-core.test.ts`.                                                                       |
| `src/testing/workspace.ts`           | Update only as required by the OpenTUI adapter signature.                                                                                                                         |
| `src/focus.test.ts`                  | Preserve focus and input-boundary evidence.                                                                                                                                       |
| `src/registry.test.ts`               | Preserve autostart, optional pane, ordering, and selection evidence.                                                                                                              |
| `src/sidebar.test.ts`                | Preserve foreground and background resize evidence.                                                                                                                               |
| `src/help.test.ts`                   | Preserve modal input blocking.                                                                                                                                                    |
| `src/terminal-session.ts`            | Compose the driver, scoped controller, and OpenTUI adapter; invoke idempotent shutdown on every exit and preserve renderer finalization.                                          |
| `src/main.ts`                        | Render aggregated unresolved-group diagnostics safely and set unsuccessful exit status.                                                                                           |
| `scripts/standalone-smoke.py`        | Add representative forced-termination and no-overlap checks while retaining quit, SIGTERM, resize, and terminal-restoration checks.                                               |
| `.github/workflows/ci.yml`           | No expected topology change. All four native jobs remain required evidence. Change only if a demonstrated platform reliability issue needs a narrow fix.                          |
| `README.md`                          | Update architecture and verification descriptions after extraction lands.                                                                                                         |
| `docs/compatibility-guardrails.md`   | Remains the user-visible compatibility contract. Update only if implementation reveals an approved correction.                                                                    |

## Verification Matrix and Acceptance Criteria

| Guarantee                                         | Fast fake/controller                  | OpenTUI in-memory           | Real PTY/process group                         | Compiled binary               | Required targets  |
| ------------------------------------------------- | ------------------------------------- | --------------------------- | ---------------------------------------------- | ----------------------------- | ----------------- |
| Initial state, autostart, manual idle             | Required                              | Required                    | Not needed                                     | Required                      | All CI targets    |
| Start, natural success, nonzero failure           | Required                              | Required                    | Required                                       | Required                      | All CI targets    |
| Input only for selected running pane              | Required                              | Required                    | Required through integration                   | Required                      | All CI targets    |
| Terminal responses reach current background panes | Required                              | Required                    | Required through integration                   | Covered by terminal behavior  | All CI targets    |
| Foreground and background resize                  | Required                              | Required                    | Required                                       | Required                      | All CI targets    |
| Manual stop preserves output/status               | Required                              | Required                    | Required                                       | Smoke via stop/restart        | All CI targets    |
| Restart waits and uses fresh run/screen           | Required                              | Required                    | Required no-overlap check                      | Required                      | All CI targets    |
| Stale and unknown events are ignored              | Required                              | Not duplicated              | Not needed                                     | Not needed                    | Host test plus CI |
| Duplicate active start is rejected                | Required                              | Not duplicated              | No-overlap is representative                   | Not needed                    | Host test plus CI |
| Partial startup failure                           | Required                              | Status projection required  | Optional when reproducible                     | Not needed                    | Host test plus CI |
| SIGTERM then SIGKILL escalation                   | Fake timeout/control required         | Not needed                  | Required with TERM-ignoring child              | Representative smoke          | macOS and Linux   |
| Descendant process-group cleanup                  | Fake attempt record required          | Not needed                  | Required                                       | Required                      | macOS and Linux   |
| PTY drain and close                               | Fake ordering required                | Not needed                  | Required                                       | Covered by clean exit         | macOS and Linux   |
| One cleanup failure does not skip peers           | Required                              | Not needed                  | Not safely injectable                          | Not needed                    | Host test plus CI |
| Unresolved group diagnostic and nonzero exit      | Required at controller/main boundary  | Terminal release required   | Best-effort representative                     | Optional if safely injectable | Host test plus CI |
| Terminal restoration on quit, signal, failure     | Controller failure path required      | Renderer finalizer required | Not sufficient alone                           | Required                      | All CI targets    |
| No command bytes or env in telemetry              | Safe-field assertions where available | Not needed                  | Trace/log inspection test or existing contract | Not needed                    | Host test plus CI |

Scope is complete only when:

1. Production uses `WorkspaceController`; no second lifecycle state machine remains in `processWorkspace` or `ProcessPane`.
2. Every compatibility guardrail maps to at least one passing test in the matrix.
3. Fake tests prove cleanup aggregation and stale-run behavior deterministically.
4. Real PTY tests prove process-group termination, forced escalation, and PTY closure on macOS and Linux.
5. Compiled-binary smoke tests prove quit and SIGTERM cleanup plus terminal restoration on all four CI targets.
6. `bun run check` and `bun run test:binary` pass locally where supported.
7. All four native GitHub Actions jobs pass on the implementation PR.
8. The implementation PR contains no unrelated UX, release, or dependency changes.

## Big-Bang RGR TDD Implementation Loop

Use one branch and one pull request. The branch can use internal Red-Green-Refactor commits, but production must have one ownership cutover. Do not merge or ship a state where both the legacy workspace and the new controller can own process lifecycle.

### Gate 0: Start from the completed prerequisite

- PR #11 is merged and #5 is closed.
- Branch from or rebase onto its merge commit.
- Run `bun run check` before changing production behavior.

### Red: Define the complete replacement contract

Before rewiring production, add failing tests through the public controller and process-driver interfaces for:

1. typed lifecycle results for start failure, runtime failure, nonzero exit, manual stop, and cleanup failure;
2. autostart initialization and manual idle commands;
3. selected user input, background terminal responses, and all-pane resize;
4. restart ordering, duplicate start rejection, and fresh terminal reset;
5. stale and unknown output, exit, failure, and cleanup completion events;
6. multi-pane shutdown where one cleanup fails but every cleanup is attempted;
7. retry of a previously failed cleanup during final shutdown;
8. aggregated safe unresolved-group diagnostics and unsuccessful exit propagation.

Use the PR #11 recording fake. Do not create a second fake or mock Bun/OpenTUI modules.

### Green: Build the complete headless replacement

- Replace `PaneStatus` with `PaneLifecycle` and keep existing UI text through `renderStatus`.
- Implement the scoped `WorkspaceController`, ordered events, generation checks, lifecycle command queue, direct I/O routing, and idempotent shutdown.
- Move the recording fake behind the production `ProcessDriver` contract.
- Adapt the existing Bun PTY behavior to `ProcessDriver` with the same shell, environment, timeout, drain, telemetry, and process-group behavior.
- Add real PTY contract tests, including a TERM-ignoring child that requires SIGKILL and leaves no descendants.

At this point the replacement is proven headlessly, but the production entry point still uses the old workspace. Do not add a feature flag or runtime switch.

### Cutover: Replace all production ownership together

In one coordinated production change:

- make `processWorkspace` translate OpenTUI input and render controller snapshots/events;
- compose the driver, controller, and OpenTUI adapter in `terminalSession`;
- route cleanup failures to safe stderr diagnostics and an unsuccessful exit in `main`;
- remove PTY, fiber, run-generation, and lifecycle ownership from `ProcessPane`;
- remove the legacy `Action` lifecycle queue and direct `runPty` orchestration from `processWorkspace`;
- delete the test-only prototype after its behavior exists through the production seam.

The cutover is incomplete if any production code path can start or clean up a process without the controller.

### Refactor: Remove obsolete shape without widening scope

- Rename `ProcessPane` to `TerminalPane` only if it still exists and that is its truthful role.
- Keep process-driver contracts in `workspace-core.ts` unless a dedicated `process-driver.ts` creates a deeper, clearer module.
- Remove duplicate state transitions, test helpers, and imports left by the old ownership model.
- Update README architecture and verification text.
- Do not add unrelated UX, release, dependency, or configuration changes.

### Verify: Run every compatibility surface

Run and fix each layer:

1. controller and fake-driver tests;
2. registry, ordering, focus, paste, Ctrl-Z, help, sidebar, and all-pane resize tests;
3. integrated OpenTUI plus real-PTY tests;
4. process-group, forced-escalation, drain, and closure tests;
5. compiled-binary quit, SIGTERM, resize, no-overlap, and terminal-restoration smoke trials;
6. `bun run check` and `bun run test:binary`;
7. all four native GitHub Actions jobs.

Do not weaken assertions to admit the replacement. A behavior change requires an explicit update to the compatibility contract and implementation PR rationale.

### Complete: Close the consolidated map

- Resolve implementation PR feedback and keep all required checks green.
- Merge the implementation PR.
- Close #4 and #7 as consolidated and completed by the spec and implementation PR.
- Close #1 with links to this spec, PR #11, the implementation PR, and the passing CI run.

## Risks and Open Questions

### Risks

- Effect interruption can accidentally classify an intentional stop as failure. Tests must distinguish controller-requested stop from natural exit and adapter failure.
- OpenTUI focus callbacks can produce commands during terminal recreation. Generation checks and command serialization must prevent input from reaching an old run.
- Finalizer failures can obscure the original failure. Shutdown must aggregate cleanup failures and preserve the primary typed outcome where possible.
- Native signal and PTY behavior can differ across macOS and Linux. The four-job matrix is acceptance evidence, not optional coverage.
- The big-bang cutover concentrates review risk. The complete fake contract, one ownership assertion, and full native matrix are hard merge gates.

### Open questions

No product decision remains open. Implementation may choose whether `ProcessDriver` contracts live in `workspace-core.ts` or `process-driver.ts` based on which produces the smaller coherent public interface. That file-placement choice must not change the ownership model above.
