import { EmbeddedTerminalRenderable, type CliRenderer } from "@opentui/core";
import type { Fiber } from "effect";
import type { ProcessDefinition } from "./config";

export class ProcessPane {
  terminal: EmbeddedTerminalRenderable;
  pty: Bun.Terminal | undefined;
  fiber: Fiber.Fiber<void, never> | undefined;
  run = 0;
  status = "idle";

  constructor(readonly definition: ProcessDefinition, private readonly renderer: CliRenderer, readonly index: number) {
    this.terminal = this.makeTerminal();
  }

  get active() {
    return this.status === "starting" || this.status === "running" || this.status === "stopping";
  }

  makeTerminal() {
    return new EmbeddedTerminalRenderable(this.renderer, {
      id: `terminal-${this.index}-${this.run}`,
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      maxScrollback: 10000,
      selectable: false,
      onData: (bytes) => this.pty?.write(bytes),
      onTerminalResize: (columns, rows) => this.pty?.resize(Math.max(1, columns), Math.max(1, rows)),
    });
  }
}
