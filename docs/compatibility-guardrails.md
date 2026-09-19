# Compatibility guardrails

The headless-workspace extraction must preserve the current behaviors and implement the shutdown guarantees recorded here. A change outside this contract is a deliberate UX change and needs its own decision and coverage.

## Commands and selection

- Configured commands retain their declaration-order identity, title, cwd, environment overlay, and autostart policy.
- Autostarted commands start once when the session opens. Idle commands remain visible and start only on Enter.
- Running commands sort before inactive commands. Selection follows the command identity when that ordering changes.
- Navigation uses j/k and Up/Down. Enter starts an inactive command or enters input mode for the selected running command.
- `x` stops the selected command. `r` waits for its cleanup, then restarts it with a fresh terminal screen. `q` and Ctrl-C in navigation quit cmdz.

## Input and display

- Navigation never forwards keys or paste to a child process.
- In input mode, all input belongs to the selected running child except Ctrl-Z, which returns to navigation. Ctrl-C in input mode interrupts only that child.
- A help modal blocks other input until `?` or Escape dismisses it.
- `h` hides or shows the sidebar without changing selection; all terminal panes resize to the available body area.
- Clicking a selected running terminal enters input mode. Clicking an inactive terminal neither starts it nor enters input mode.
- The status header and sidebar expose text status, not color alone.

## Lifecycle and output

- Natural exit retains terminal output. Exit code 0 displays `succeeded`; other exit codes display `failed (<code>)`. Natural exits do not restart automatically.
- A manual stop retains terminal output and displays `stopped`.
- Restart clears the prior terminal screen before starting its next run.
- A run-generation identifier prevents late lifecycle events from a previous run from changing a newer run's state.
- Quit and OS interruption clean up all owned process groups and restore the terminal. Unresolved groups are reported with manual cleanup guidance and make cmdz exit unsuccessfully.

## Deliberately excluded from this extraction

- New navigation modes, split panes, persistent configuration changes, config reload, search, copy, cross-run history, and a user-facing headless CLI.
