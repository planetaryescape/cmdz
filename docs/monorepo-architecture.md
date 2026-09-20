# Workspace architecture

cmdz is a Bun workspace with three private packages:

```text
@cmdz/core ← @cmdz/tui ← @cmdz/cli
```

- `@cmdz/core` owns workspace definitions, process-driver contracts, the lifecycle controller, and its runtime facade. It has no Bun PTY or OpenTUI dependency.
- `@cmdz/tui` owns OpenTUI renderables, key translation, the UI action queue, and snapshot/event projection. It imports no Bun PTY code.
- `@cmdz/cli` owns configuration loading, the Bun/POSIX PTY adapter, terminal-session construction, telemetry, and binary compilation.

The root package coordinates installs, formatting, linting, type checking, aggregate tests, and binary smoke testing. It is also the type surface for user configuration imports from `cmdz`.

Internal package imports use explicit workspace export paths. The root `bun run check` command runs each package's tests after applying shared static checks.
