import { createCliRenderer } from "@opentui/core";
import { processWorkspace } from "./process-workspace";
import type { ProcessDefinition } from "./config";
import { Cause, Effect, Exit, Schema } from "effect";

class TerminalSessionError extends Schema.TaggedError<TerminalSessionError>()(
  "TerminalSessionError",
  { message: Schema.String },
) {}

export const terminalSession = (definitions: readonly ProcessDefinition[]) => Effect.gen(function* () {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return yield* Effect.fail(
      new TerminalSessionError({ message: "cmdz requires an interactive terminal." }),
    );
  }

  const renderer = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => createCliRenderer({
        exitOnCtrlC: false,
        exitSignals: [],
        consoleMode: "disabled",
        screenMode: "alternate-screen",
      }),
      catch: () => new TerminalSessionError({ message: "Unable to initialize the terminal." }),
    }).pipe(Effect.withSpan("terminal.acquire")),
    (renderer) => Effect.sync(() => renderer.destroy()).pipe(
      Effect.tap(() => Effect.logInfo("Terminal renderer released")),
      Effect.withSpan("terminal.release"),
    ),
  );

  yield* Effect.logInfo("Terminal session ready");
  yield* processWorkspace(renderer, definitions);
}).pipe(
  Effect.scoped,
  Effect.onExit((exit) => {
    const outcome = Exit.isSuccess(exit)
      ? "completed"
      : Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failed";
    return Effect.logInfo("Terminal session ended").pipe(
      Effect.annotateLogs({ outcome }),
    );
  }),
  Effect.withSpan("terminal.session"),
);
