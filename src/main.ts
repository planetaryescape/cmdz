import { Cause, Effect, Exit } from "effect";
import { terminalSession } from "./terminal-session";
import { telemetry } from "./telemetry";
import { loadConfig } from "./config";

const controller = new AbortController();
const interrupt = () => controller.abort();

process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

try {
  const exit = await Effect.runPromiseExit(
    loadConfig(process.argv[2] ?? "cmdz.ts").pipe(
      Effect.flatMap(terminalSession),
      Effect.provide(telemetry),
    ),
    { signal: controller.signal },
  );
  if (Exit.isFailure(exit) && !controller.signal.aborted) {
    console.error(Cause.pretty(exit.cause));
    process.exitCode = 1;
  }
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
