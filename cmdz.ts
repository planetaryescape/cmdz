import { Command } from 'cmdz'

export default [
  Command('Demo', {
    command: 'bun run packages/cli/src/demo-command.ts',
  }),
  Command('Optional', {
    command: 'bun run packages/cli/src/demo-command.ts',
    autostart: false,
  }),
]
