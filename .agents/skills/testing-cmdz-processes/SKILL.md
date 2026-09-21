---
name: testing-cmdz-processes
description: Explains cmdz process ownership and captures deterministic TUI screenshots through real PTYs. Use when changing WorkspaceController lifecycle behavior, the ProcessDriver boundary, PTY cleanup, terminal interactions, or visual states.
---

# Testing cmdz processes

Use the narrowest harness that proves the behavior under review. A rendered screen proves UI state; it does not prove process-group cleanup.

## Process boundary

```text
workspace-session (composition root)
  ├─ creates WorkspaceController
  └─ provides ptyProcessDriverLayer
       └─ makePtyProcessDriver()
            └─ private Bun PTY adapter

WorkspaceController ──depends on──▶ ProcessDriver
Recording driver ─────provides────▶ ProcessDriver in controller tests
PTY driver ───────────provides────▶ ProcessDriver in production/integration tests
```

- `WorkspaceController` owns lifecycle policy, run generations, stale-run rejection, routing, and cleanup retries.
- `ProcessDriver` is the core service contract. `start` returns a `ProcessRun` with `write`, `resize`, `awaitExit`, and `cleanup`.
- `makePtyProcessDriver` constructs the production implementation.
- `ptyProcessDriverLayer` installs that implementation under the Effect service tag.
- `workspace-session` chooses the production layer at the composition root.
- `pty-process.ts` keeps `Bun.spawn`, `Bun.Terminal`, process-group signalling, TERM→KILL escalation, and drain timeout policy private.
- The recording driver implements the same contract and exposes deterministic gates for controller tests.

## Evidence levels

Choose evidence by claim:

1. **Controller policy:** use `packages/core/src/workspace.test.ts` with the recording driver. Coordinate concurrency with gates or `Deferred`, never sleeps.
2. **Rendered interaction with real child PTYs:** use the OpenTUI capture harness described below.
3. **PTY/process-group mechanics:** use `packages/cli/src/pty-process.test.ts` and assert process existence, exit, cleanup, and terminal closure.
4. **Whole application wiring:** use the focused CLI integration tests under `packages/cli/src`.
5. **Shipped executable behavior:** use `bun run test:binary`; screenshots or the test renderer cannot prove compiled-binary packaging or terminal restoration.

## Capture visual states in an Amp orb

Run from the repository root:

```sh
bun run capture:tui
```

The harness writes representative navigation, input, and help states to:

```text
.amp/in/artifacts/cmdz/
├── navigation.svg
├── navigation.png  # when ImageMagick is installed
├── input.svg
├── input.png
├── help.svg
└── help.png
```

Pass another output directory when needed:

```sh
bun run capture:tui .amp/in/artifacts/my-review
```

The harness uses OpenTUI's deterministic renderer but runs the real `runWorkspace` composition and production PTY driver. It autostarts a real Demo child, sends real terminal input, and waits for semantic screen text before each capture.

After capturing:

1. Inspect every PNG with the media viewer; creating an image is not verification.
2. Verify navigation, input, and help states separately.
3. Link representative inspected artifacts in the final response or PR description.
4. State that these are renderer captures, not screenshots of Amp's Terminal tab.

## Run the live application in the orb terminal

The production entrypoint requires a TTY. For internal inspection, use a temporary tmux session:

```sh
tmux new-session -d -s cmdz-live -x 100 -y 30 -c "$PWD" \
  'CMDZ_TELEMETRY=false bun run dev'
tmux capture-pane -t cmdz-live -p -e
```

Drive it with `tmux send-keys`, then stop the app with its own `q` command and remove the temporary session. Do not claim a native pixel screenshot from `tmux capture-pane`; use the visual capture harness for reviewable images.

## Adding a captured state

Edit `packages/cli/src/testing/capture-workspace.ts`:

1. Drive behavior through `mockInput`, the same public input seam used by the TUI.
2. Wait for semantic text with `workspace.waitFor(...)`.
3. Capture only after the expected state is visible.
4. Add a focused assertion in `capture-workspace.test.ts` that would fail if the state were absent.
5. Keep fixture commands local and deterministic. Never include secrets or environment dumps in artifacts.

## Verification

For harness-only changes:

```sh
bun test packages/cli/src/testing/capture-workspace.test.ts
bun run capture:tui
bun run typecheck
bun run lint
bun run format:check
```

For process lifecycle or adapter changes, finish with the full suite:

```sh
bun run check
```
