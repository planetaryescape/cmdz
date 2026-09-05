import { expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "./command";
import { loadConfig, parseConfig } from "./config";

test("Command declares data; validation applies defaults and resolves cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "cmdz-config-"));
  try {
    await mkdir(join(root, "web"));
    const commands = await Effect.runPromise(parseConfig([
      Command("Web", { command: "bun run dev", cwd: "web" }),
      Command("Studio", { command: "bun run studio", title: "Database", autostart: false, env: { MODE: "test" } }),
    ], root));
    expect(commands).toEqual([
      { name: "Web", title: "Web", command: "bun run dev", cwd: join(root, "web"), env: {}, autostart: true },
      { name: "Studio", title: "Database", command: "bun run studio", cwd: root, env: { MODE: "test" }, autostart: false },
    ]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("rejects malformed, empty, duplicate, and invalid directory definitions", async () => {
  const inputs: unknown[] = [
    {}, [], [{ name: "Web", command: 1 }],
    [Command("Web", { command: " " })],
    [Command("Web", { command: "echo ok", autostart: false, cwd: "/cmdz-missing-directory" })],
    [Command("Web", { command: "echo ok" }), Command("Web", { command: "echo duplicate" })],
    [Command("Web", { command: "echo ok", env: { "BAD=KEY": "value" } })],
  ];
  for (const input of inputs) {
    expect(Exit.isFailure(await Effect.runPromiseExit(parseConfig(input, process.cwd())))).toBe(true);
  }
});

test("loads a TypeScript default export relative to its config file", async () => {
  const root = await mkdtemp(join(tmpdir(), "cmdz-load-"));
  try {
    const file = join(root, "cmdz.ts");
    await writeFile(file, 'export default [{ name: "Local", command: "echo ok" }];');
    const commands = await Effect.runPromise(loadConfig(file));
    expect(commands[0]?.cwd).toBe(root);
    expect(commands[0]?.autostart).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(loadConfig(join(root, "missing.ts"))))).toBe(true);
  } finally {
    await rm(root, { recursive: true });
  }
});
