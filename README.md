# cmdz

A local development multiplexer built with Effect and OpenTUI.

## Development

```sh
bun install
bun run dev
```

Run in an interactive terminal. The checked-in `cmdz.ts` starts Demo automatically and keeps Optional idle.

- j/k or Up/Down: select a command in the sidebar.
- h in navigation: hide/show the sidebar. Selection stays unchanged and all terminal panes resize.
- ? in navigation: show shortcut help. ? or Escape dismisses it; other input is blocked while help is open.
- Enter: start an idle command, or focus a running command.
- Click the selected running terminal: enter input mode. Clicking an inactive terminal does not start or focus it.
- Type a message, `size`, or `exit` in the demo.
- Ctrl-Z: return to navigation.
- x: stop the demo.
- r: restart it with a fresh terminal screen.
- q or Ctrl-C in navigation: quit cmdz.
- Ctrl-C in input mode: interrupt the child only.

All keys except Ctrl-Z belong to the child in input mode. Paste is accepted only in input mode; navigation never forwards it to a child.

Effect owns process and renderer cleanup; SIGINT and SIGTERM interrupt the session. Running commands are grouped above inactive ones without changing the selected command.

## Standalone binary

```sh
bun run build:binary
./dist/cmdz /path/to/project/cmdz.ts
```

The executable embeds Bun and OpenTUI's native library. Users do not need Bun, Node, or a local cmdz package to run it. Commands launched by cmdz still need their own runtimes and executables.

At runtime, the CLI provides `import { Command } from 'cmdz'` to external TypeScript configs, including local helper modules. Other package imports must resolve from the user's project. The virtual module supplies runtime exports, not editor type declarations.

The build targets the host platform. macOS arm64 is verified; Linux and other architectures still need their own build/runtime checks before release. No installers, signing, or publishing are included yet.

```sh
bun run test:binary
```

This builds the executable, copies it into a temporary project without `node_modules`, and runs PTY checks with no Bun on `PATH`. It verifies config imports, cwd/env, input, initial dimensions, resizing, sidebar toggle, quit/SIGTERM cleanup, and terminal restoration. Python 3 is required only for this developer smoke test.

Compiled startup disables automatic `.env` and `bunfig.toml` loading. Config files remain trusted executable TypeScript.

## Configuration

```ts
import { Command } from 'cmdz'

export default [
  Command('Web', { command: 'bun run dev', cwd: 'apps/web' }),
  Command('Studio', {
    command: 'bun run db:studio',
    autostart: false,
    env: { LOG_LEVEL: 'debug' },
  }),
]
```

Save as `cmdz.ts`. `Command` only creates data. The CLI validates the entire array before opening the UI or spawning processes. Names must be unique and cwd must exist, including for optional commands.

- `command`: required shell string, executed through `/bin/sh -c`; pipes and `&&` work, interactive shell aliases do not.
- `cwd`: relative to the config file, or absolute; defaults to the config directory.
- `title`: display label; defaults to the name.
- `autostart`: defaults to true and is config-only.
- `env`: overrides the inherited environment. The runner does not load dotenv files; a child such as Bun may apply its own dotenv behavior. `TERM` is set to `xterm-256color` for the embedded terminal.

By default the CLI loads `cmdz.ts` from the launch directory. Use `bun run dev /absolute/path/to/cmdz.ts` for an explicit path. The CLI supplies the `cmdz` import; external configs must resolve any other package imports themselves. Configuration is trusted TypeScript, not a sandbox. Reloading configuration requires restarting cmdz.

Direct dependencies:

- `effect`: `4.0.0-rc.112`
- `@opentui/core`: `0.5.10`

Development tooling: tsgo (`@typescript/native-preview`), Bun types, Oxlint with vendored anti-slop rules, and oxfmt using the supplied formatting preferences. Runtime dependencies remain unchanged.

```sh
bun run check
```

This runs strict type checking, linting with warnings treated as failures, formatting checks, and tests. Individual commands: `bun run typecheck`, `bun run lint`, `bun run format:check`, and `bun run test`. Use `bun run format` to apply formatting.

Application source remains strictly checked. `skipLibCheck` preserves the previous type-check command's treatment of dependency declarations: OpenTUI's event-emitter override and Effect's `TextDecoderOptions` reference currently fail with full dependency declaration checking.

All generic anti-slop rules and its Effect rule are enabled. See [lint provenance and maintenance](tools/oxlint/README.md).

## Terminal session

`src/terminal-session.ts` acquires the renderer as an Effect scoped resource and removes input listeners before destroying it. `src/main.ts` translates OS termination signals into Effect interruption. Renderer initialization errors and non-interactive terminals fail visibly.

`src/process-workspace.ts` owns the named process registry, selection, and serialized lifecycle actions. `src/process-pane.ts` holds each process's terminal state. `src/pty-process.ts` owns a Bun PTY and its process group. OpenTUI's built-in `EmbeddedTerminalRenderable` handles ANSI parsing, input encoding, and terminal resizing. No PTY or parser dependency was added.

On release, signal the owned process group, wait up to three seconds for the leader, then force-kill remaining group members. Drain pending PTY output with a bounded wait before closing it. Deliberately detached descendants are outside this process-group ownership model.

```sh
bun run test
```

Integration tests exercise real PTY output, ANSI/Unicode rendering, exit codes, descendant cleanup, focus/input, resize, stop, restart, and natural exit. Separate real-host PTY trials verified quit and SIGTERM cleanup and terminal restoration. The repository now has a local tsgo type-checking toolchain; it no longer relies on another checkout's compiler.

## Local telemetry with Motel

`bun run dev` sends OTLP/HTTP JSON traces and logs to Motel at `http://127.0.0.1:27686`, under service `cmdz`. Start Motel separately; cmdz does not manage its daemon.

- `CMDZ_TELEMETRY=false` disables export.
- `CMDZ_OTLP_URL` overrides the collector base URL.
- Spans: `terminal.session`, `terminal.acquire`, `terminal.release`, `process.workspace`, `process.run`, and `process.release`.
- Logs: ready, released, and ended, with completed/interrupted/failed outcomes.
- Effect logs go to Motel rather than drawing over the TUI.
- No command output, arbitrary keystrokes, or environment values are recorded.
- Export uses Effect's built-in observability modules, with no additional dependencies. Shutdown flush is bounded to one second per exporter.

```sh
curl 'http://127.0.0.1:27686/api/traces?service=cmdz'
curl 'http://127.0.0.1:27686/api/logs?service=cmdz'
```

Verified trace/log ingestion for normal quit, signal interruption, and non-TTY failure. Verified clean terminal exit with the collector unavailable and telemetry disabled.

Search, copy, config reload, and cross-run history remain deferred. The sidebar currently supports keyboard navigation only.

See [the draft specification](docs/dev-multiplexer-spec.md) and [references](docs/references.md).
