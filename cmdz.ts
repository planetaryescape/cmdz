import { Command } from "cmdz";

export default [
  Command("Demo", {
    command: "bun run src/demo-command.ts",
  }),
  Command("Optional", {
    command: "bun run src/demo-command.ts",
    autostart: false,
  }),
];
