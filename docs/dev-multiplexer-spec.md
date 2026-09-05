# cmdz: local development multiplexer

Status: draft for annotation, not an approved implementation plan.

## 1. Goal

Run user-defined local commands in one terminal UI. Declare the commands once, start the common ones automatically, and keep optional tools available to launch on demand.

Study SST Mosaic and Turborepo's TUI for interaction design and architecture. Borrow their useful parts without importing their infrastructure or build systems.

### Confirmed requirements

- A declarative API for local development commands.
- Per-command autostart configuration.
- A multiplexer for user processes only.
- Study both UI/UX and how the runner, terminal, and UI fit together.
- Use SST Mosaic and Turborepo as references.
- No SST resource linking.
- Configuration lives in `cmdz.ts`, default-exporting an array of plain `Command(name, options)` definitions.
- Build with Effect and OpenTUI.
- Prefer a factory-style API inspired by SST or Alchemy, not a nested `dev.scripts` object.
- Autostart defaults to true and is controlled only by configuration.
- Initial platform support: macOS and Linux.
- Group running processes above inactive processes, retaining selection by ID.
- Use SST's Enter/Ctrl-Z interaction model.
- Follow SST's screen-clearing behavior on restart.
- Copy/search, config reload, and stream mode are outside the MVP.

Everything below labelled **proposed** is a choice to review, not an agreed requirement.

### Non-goals

- Infrastructure deployment, cloud credentials, functions, workers, tunnels, or resource linking.
- Build caching, dependency graphs, workspace scheduling, or a replacement for Turborepo.
- A terminal emulator implemented from scratch.
- Remote sessions, a daemon, or a web UI.

## 2. Case study: SST Mosaic

Evidence: local SST checkout at commit `74671bf90`, branch `dev`. Findings are from source inspection, not a live UI trial.

### Public command API

```ts
new sst.x.DevCommand('Studio', {
  dev: {
    command: 'bun run db:studio',
    directory: 'packages/database',
    title: 'Database Studio',
    autostart: false,
  },
  environment: {
    LOG_LEVEL: 'debug',
  },
})
```

Relevant fields are `dev.command`, `dev.directory`, `dev.title`, `dev.autostart`, and `environment`. SST calls it `command`, not `script`.

- The component name provides stable identity and a fallback title.
- Autostart defaults to true. False still creates a pane, with a prompt to press Enter to start.
- A stopped or exited process can be started again with Enter.
- The TUI does not persistently toggle the configuration's autostart value.
- Environment variables are inherited from the launching process, with explicit values added as overrides.
- This does not mean arbitrary `.env` files in a working directory are loaded by the process runner. Environment inheritance and dotenv loading are separate concerns.
- The standalone `DevCommand` JSDoc advertises a default command, but its implementation does not supply one. Empty commands are skipped by the multiplexer. Our API should require a command.

### UI behavior worth borrowing

- Sidebar plus one selected terminal pane.
- Keyboard and mouse selection of processes.
- Separate navigation and terminal-input modes.
- Context-sensitive shortcut hints.
- Start and kill controls without leaving the UI.
- Output remains available after exit.
- Per-process terminal state, ANSI rendering, scrollback, and resize handling.
- Mouse selection and clipboard copying.
- Running and dead processes are visually distinguished.

SST sorts system panes before user panes and running processes before dead ones, while retaining selection by identity. cmdz will likewise group running processes before inactive ones. Within-group ordering remains a design detail.

### Architecture

```text
component configuration
  -> serialized _dev outputs
  -> completed project event
  -> pane configuration
  -> child wrapper fetches command and environment
  -> subprocess inside a virtual terminal
```

The multiplexer uses Go, tcell, and a virtual-terminal layer. `PaneConfig` separates identity, display metadata, launch arguments, environment, working directory, autostart, and whether the pane can be killed.

A child wrapper listens for updated configuration and restarts when command or relevant environment changes. This is not a general crash-restart policy. The inspected multiplexer also starts an existing dead pane when a later process-registration event has autostart enabled, so autostart is not strictly a one-time operation in SST.

**Borrow:** process identity, explicit input modes, per-process terminals, and separation between configuration and running state.

**Do not copy:** Pulumi outputs, cloud-specific environment resolution, internal HTTP server, child SST wrappers, or credential refresh.

## 3. Case study: Turborepo TUI

Evidence: official development guide and upstream `main` source inspected during drafting. Upstream links are moving references and may differ from a released Turbo binary. No live UI trial was performed.

### Documented interactions

| Control        | Turborepo behavior       |
| -------------- | ------------------------ |
| Up/Down or j/k | Select task              |
| m              | Show keybind popup       |
| h              | Hide/show task list      |
| p              | Toggle selection pinning |
| u/d            | Scroll logs              |
| c              | Copy highlighted logs    |
| i              | Enter task interaction   |
| Ctrl-Z         | Leave task interaction   |

Interactive input is associated with interactive task configuration. Persistent development tasks are treated as long-running and interactive. `persistent` is not the same as optional/manual autostart.

Turbo gets task commands from package scripts and adds task metadata in `turbo.json`. cmdz does not need that package-graph model.

### Architecture

The inspected UI crate has distinct modules for app state, input, task table, terminal output, panes, scrolling, search, popup help, clipboard, and preferences.

The task runner sends events through `TuiSender` to an `AppReceiver`. Events include start, output bytes, end result, stdin attachment, task-list updates, resize, and shutdown acknowledgement.

Each task's terminal output owns a terminal parser, optional stdin handle, scrollback, status, and result. The inspected upstream version uses a Ghostty parser wrapper. This is an implementation detail, not a library choice for cmdz.

The source also contains events for output search and switching between the TUI and streamed output. These are useful later candidates; this draft does not assume their availability in every released version.

**Borrow:** explicit runner-to-UI events, readable process results, help popup, hideable sidebar, and distinct interaction mode.

**Do not copy:** caching states, task dependency scheduling, package graph, or dependency-aware watch mode.

## 4. Comparison and proposed choices

| Concern             | SST Mosaic                    | Turborepo                          | cmdz proposal                               |
| ------------------- | ----------------------------- | ---------------------------------- | ------------------------------------------- |
| Primary abstraction | Resource-associated process   | Build/dev task                     | Named local command                         |
| Command declaration | `dev.command`                 | Package script plus task metadata  | Explicit command in cmdz config             |
| Optional startup    | `autostart: false`            | Not established by this case study | First-class manual commands                 |
| Main layout         | Sidebar and selected terminal | Task list and selected output      | Same basic layout                           |
| Input mode          | Enter to focus                | i to interact                      | Enter to start/focus, Ctrl-Z to return      |
| Status              | Running/dead presentation     | Task status and result             | Distinguish success, failure, and user stop |
| Help                | Contextual hints              | Keybind popup                      | Short hints plus help popup                 |
| Sidebar visibility  | Fixed in inspected layout     | Toggleable                         | Toggleable                                  |
| Runner/UI boundary  | Pane events plus SST wrappers | Typed event sender/receiver        | In-process commands and events              |
| Config updates      | Deployment-driven updates     | Task/watch integration             | Explicitly deferred                         |

## 5. Proposed configuration API

Selected API: a default-exported array of plain factory results. No generators, global registration, constructor side effects, or top-level await.

```ts
import { Command } from 'cmdz'

export default [
  Command('Web', { command: 'bun run dev', cwd: 'apps/web' }),
  Command('Studio', { command: 'bun run db:studio', autostart: false }),
]
```

`Command` creates a definition only. The CLI imports the config and validates the entire array, including duplicate names and working directories, before creating the renderer or starting any child. Config imports remain trusted executable code; they are not sandboxed. Effect owns execution and cleanup without appearing in user configuration.

Conceptual contract, independent of implementation language:

| Field           | Contract                                                    | Default          |
| --------------- | ----------------------------------------------------------- | ---------------- |
| Factory name/ID | Stable, non-empty command ID                                | Required         |
| command         | Non-empty command string                                    | Required         |
| title           | Display name, separate from identity                        | Command ID       |
| cwd             | Working directory, relative to config directory or absolute | Config directory |
| env             | String values overlaid on inherited environment             | Empty overlay    |
| autostart       | Whether to start at session startup                         | true             |

### Environment semantics

- Snapshot the launching process's environment at session startup.
- Merge each command's explicit `env` on top, without modifying the parent environment.
- Changing `cwd` does not change inherited variables or load `.env` files.
- No automatic dotenv loading or environment isolation in the MVP.
- Do not print the merged environment in diagnostics.
- Do not force a separate `inheritEnv` option until there is a concrete use case.

### Command execution

**Implemented:** use the platform shell for command strings so quoting, pipes, redirects, and `&&` work as users expect. For an initial POSIX target, use `/bin/sh -c`, not an interactive/login shell with user aliases. This differs from SST's shell-word splitting followed by direct execution.

Treat configuration as trusted executable code. Do not interpolate UI input into commands. TypeScript configuration also executes code when loaded, so its loader/runtime choice must be settled before implementation.

The initial array-config implementation uses command strings. A command string such as `bun run generate && bun run dev` asks a shell to interpret `&&`. An argument array such as `["bun", "run", "dev"]` launches an executable directly; shell operators do not work unless a shell is explicitly launched. Strings provide familiar dev-script syntax. The runner does not apply additional string interpolation. Windows shell behavior is outside the initial scope.

## 6. Proposed UI

```text
cmdz                           Web [running]
                               bun run dev
> Web         running          --------------------------------
  API         running          Local: http://localhost:3000
  Studio      idle
  Codegen     succeeded
  Check       failed (1)

                               [live output]

Enter start/focus   x stop   r restart   h sidebar   ? help
```

- One selected terminal at a time. No split-pane layouts in the MVP.
- Group running processes above inactive processes, like SST. Preserve selected ID when a process moves between groups. Proposed tie-breaker within each group: declaration order.
- Label status with text as well as color.
- Keep optional commands visible with an idle explanation.
- Keep the UI open when commands finish, including when all commands are idle or exited.
- Show command and working directory in a details/header view without exposing environment values.
- A narrow terminal should still provide a usable selected-process view and help, rather than overlapping panels.

### Input modes

**Navigation:** keys control cmdz. No input reaches a child.

**Interactive:** ordinary keys reach the selected running child. Show a clear input-mode indicator. Reserve Ctrl-Z to return to navigation; this means Ctrl-Z cannot suspend the child through this binding.

**Help:** modal shortcut list; Escape returns to the previous navigation view.

### Proposed keybindings

| Key             | Navigation behavior                                  |
| --------------- | ---------------------------------------------------- |
| j/k or Up/Down  | Select process                                       |
| Enter           | Start idle/exited process, or focus running terminal |
| x               | Stop selected process                                |
| r               | Restart selected process                             |
| h               | Hide/show sidebar                                    |
| ?               | Show help                                            |
| Ctrl-U / Ctrl-D | Scroll half a page                                   |
| Ctrl-G          | Return to live output                                |
| Ctrl-L          | Clear selected output                                |
| Ctrl-C          | Shut down cmdz and its children                      |

In interactive mode, Ctrl-C goes to the child, not cmdz. Ctrl-Z returns to navigation. Supervisor shortcuts such as `x`, `r`, and Ctrl-L must not intercept ordinary child input in interactive mode.

Scrolling pauses follow mode. New output must not move a reader away from the section they are reading. Returning to the bottom resumes follow mode. Preserve each process's scroll position when switching panes.

Mouse wheel and sidebar click are proposed for the MVP. Text selection/copy is deferred.

## 7. Proposed lifecycle model

Keep configuration policy separate from runtime state:

```text
idle -> starting -> running -> exited
              |        |
              v        v
            failed   stopping -> exited
```

- `idle`: registered but never started.
- `starting`: spawn requested, result pending.
- `running`: child launched; this does not claim application readiness.
- `stopping`: termination requested, awaiting completion.
- `exited`: preserve exit code, signal, and whether cmdz requested the stop.
- `failed`: launch itself failed, such as invalid working directory or missing shell.

Display exited processes as succeeded, failed, or stopped based on outcome. A shell's “command not found” exit is an execution failure, not necessarily a spawn failure.

Rules:

1. Autostart runs once at session startup. It is not a crash-restart policy.
2. A manual stop stays stopped until the user starts it again.
3. No automatic restart on unexpected exit.
4. Restart waits for the previous process group to terminate before spawning a new run.
5. Repeated start/restart actions cannot create duplicate processes.
6. Use a per-run generation ID so a late exit/output event cannot overwrite a newer run's state.
7. Keep output after exit. On restart, follow SST: its pane start method calls `vt.Clear()` before launching the next run. Do not assume this also clears scrollback: SST's explicit clear action separately calls `ClearScrollback()`. Verify that distinction in the terminal integration trial. Cross-run history navigation is deferred.

## 8. Proposed architecture

One executable, one supervisor, one UI event loop. No internal HTTP API or daemon is needed.

```text
config loader -> validated command registry
                          |
                          v
input -> UI actions -> supervisor -> PTY process groups
          |                  ^              |
          v                  |              v
       UI state <------ lifecycle/output events
          |
          v
   terminal models -> renderer -> host terminal
```

### Module boundaries

| Module         | Owns                                                            |
| -------------- | --------------------------------------------------------------- |
| Config         | Loading, validation, defaults, path resolution                  |
| Supervisor     | Start/stop/restart, run IDs, process groups, exit results       |
| PTY adapter    | Spawn, input bytes, output bytes, resize, termination           |
| Terminal model | ANSI parsing, screen cells, bounded scrollback, follow position |
| UI state/input | Selection, modes, actions, help, layout                         |
| Renderer       | Draw state without spawning or killing processes                |
| Application    | Startup, event wiring, shutdown, terminal restoration           |

These are module boundaries within a small app, not separate services or a plugin framework.

### Commands and events

UI requests:

- Start(processId)
- Stop(processId)
- Restart(processId)
- WriteInput(processId, runId, bytes)
- ResizeTerminal(processId, rows, columns)
- Shutdown

Supervisor events:

- Starting(processId, runId)
- Started(processId, runId)
- Output(processId, runId, bytes)
- Exited(processId, runId, outcome)
- SpawnFailed(processId, runId, error)
- ShutdownComplete

Keep output as bytes until the terminal parser handles it. Output chunks can split UTF-8 characters and escape sequences. Do not parse subprocess output as independent text lines.

### PTY and rendering constraints

A PTY makes a child behave as though it has a terminal. A terminal parser interprets the child's output. A renderer paints the resulting screen inside cmdz. These are distinct responsibilities.

- Use an existing terminal parser with ANSI, cursor, alternate-screen, and resize support.
- Route input only to the selected interactive process.
- Resize background terminals too, not just the visible one.
- Start with a bounded scrollback limit, proposed 10,000 lines per process, and confirm the library also bounds cell/raw-byte storage.
- Batch output and cap redraw frequency so noisy background processes cannot block navigation.
- Apply bounded buffering/backpressure rather than growing an unlimited raw-output queue. Do not arbitrarily drop terminal bytes, which can corrupt parser state.
- Restore host terminal modes and cursor on normal exit and recoverable failure.

Selected stack: TypeScript, Effect, and OpenTUI. Use Effect for runtime orchestration and resource lifetimes, and OpenTUI for the terminal UI. Exact service boundaries, runtime/config loading, PTY integration, and terminal parser remain undecided. Verify OpenTUI's terminal embedding capabilities before selecting a PTY/parser integration; a TUI renderer alone does not establish child-terminal support. The repository currently has no application implementation to preserve.

## 9. Errors and shutdown

### Validation

Validate all definitions before starting any command. Report errors with the process ID and invalid field. An invalid optional command should not silently disappear.

### Runtime failure

Failure of one child does not stop the others. Keep its output and outcome available. Report supervisor errors in the relevant pane/status area without mixing diagnostics into the child's terminal byte stream.

### Shutdown

**Proposed POSIX behavior:** terminate all owned process groups, allow a short grace period, then force-kill remaining groups and wait for exit. Proposed grace period: three seconds. A second shutdown request skips the wait.

Do not kill processes by name or terminate unrelated listeners on occupied ports. Process-group cleanup covers normal descendants, not arbitrary daemons that deliberately escape the group. If detached children must be supported, that needs a separate ownership design.

Always attempt terminal restoration even if child cleanup fails. Report cleanup failures after restoring the terminal.

## 10. MVP and deferred scope

### Proposed MVP

- Explicit configuration with command, title, cwd, env, and autostart.
- Named processes grouped by active/inactive state, with stable selection.
- Start, stop, restart, and visible outcomes.
- PTY-backed interactive terminals.
- Navigation versus child-input modes.
- Scrollback and live-output following.
- Resize handling, hideable sidebar, contextual hints, help popup.
- Bounded output storage and responsive rendering.
- Child-group cleanup and terminal restoration.
- Clear rejection of non-interactive host terminals until a stream mode exists.

### Deferred

- Config hot reload. Restart cmdz to apply configuration edits initially.
- UI autostart overrides. Autostart stays config-only for consistency.
- Automatic crash restart, readiness checks, or start dependencies.
- Arbitrary source watching. Let `bun --watch`, Vite, and similar child tools own their watchers.
- Search, pinning, split panes, disk logs, and cross-run history.
- Text selection/clipboard.
- Stream/mono mode and CI operation.
- dotenv loading, environment isolation, and package-script discovery.
- Windows-native support. Initial support is macOS/Linux.

Config reload is intentionally moved out of the earlier suggested MVP: it introduces reconciliation rules for changed, removed, and manually stopped processes before we have tested the basic interaction model.

## 11. Verification before implementation commitment

First build a small PTY/TUI trial using disposable local commands. It should prove:

1. An autostart process runs; a manual process stays idle until Enter.
2. Input reaches only the focused child and Ctrl-Z returns control.
3. A watcher/progress display renders correctly, not as broken ANSI text.
4. One command exits successfully and another fails without closing cmdz.
5. Stop/restart leaves no overlapping normal child process groups.
6. An inherited environment value reaches a child and an explicit override wins. No `.env` file is loaded implicitly.
7. Relative cwd resolves from the config location, regardless of launch directory.
8. Output survives process exit and scroll position survives pane switching.
9. Resize and hiding the sidebar update the child terminal dimensions.
10. High-volume background output does not freeze input or grow memory without bound.
11. Shutdown restores the terminal and stops owned children.

Use unit tests for configuration, lifecycle transitions, and UI action routing. Use process integration tests for spawn/env/cwd/cleanup, and real-terminal trials for input, resize, scrollback, and alternate-screen behavior. Do not treat source inspection as proof that a terminal integration works.

## 12. Decisions for annotation

### Resolved in annotation

- Autostart defaults to true; false opts into manual startup.
- Autostart is config-only for consistency.
- macOS/Linux are sufficient initially.
- Group running processes above inactive ones, like SST.
- Use SST's Enter/Ctrl-Z focus model.
- Follow SST's restart behavior, including verifying screen versus scrollback clearing.
- Copy/search, config reload, and stream mode stay outside the MVP.

### Still open

1. Should the CLI eventually discover `cmdz.ts` in ancestor directories? Currently it uses the launch directory or an explicit path.
2. Is declaration order the right tie-breaker within running/inactive groups? The initial implementation uses it.

Implemented decisions: Bun loads the default-exported array, Effect stays internal, and command strings execute through `/bin/sh -c`.

## Sources

### SST, inspected local commit

Paths below are relative to `/Users/guidefari/source/oss/sst` at `74671bf90`:

- `platform/src/components/experimental/dev-command.ts`: public API and `_dev` output.
- `cmd/sst/mosaic.go`: child wrapper, environment inheritance, pane registration.
- `cmd/sst/mosaic/multiplexer/process.go`: pane config and process lifecycle.
- `cmd/sst/mosaic/multiplexer/multiplexer.go`: event handling, focus, navigation, copy, scroll.
- `cmd/sst/mosaic/multiplexer/draw.go`: layout, contextual help, sorting.
- `pkg/project/env.go`: SST-specific environment assembly, excluded from cmdz.

### Turborepo

- [Developing applications](https://turborepo.com/docs/crafting-your-repository/developing-applications): documented TUI controls and interactive tasks.
- [TUI modules](https://github.com/vercel/turborepo/blob/main/crates/turborepo-ui/src/tui/mod.rs): module boundaries.
- [UI events](https://github.com/vercel/turborepo/blob/main/crates/turborepo-ui/src/tui/event.rs): lifecycle, output, input, resize, and view events.
- [Sender and receiver](https://github.com/vercel/turborepo/blob/main/crates/turborepo-ui/src/tui/handle.rs): runner/UI channel and shutdown acknowledgement.
- [Terminal output](https://github.com/vercel/turborepo/blob/main/crates/turborepo-ui/src/tui/term_output.rs): parser, stdin, status, output, and scrollback ownership.
