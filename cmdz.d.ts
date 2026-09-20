declare module 'cmdz' {
  type CommandDefinition = import('./packages/cli/src/command').CommandDefinition
  type CommandOptions = import('./packages/cli/src/command').CommandOptions

  export type { CommandDefinition, CommandOptions }
  export function Command(name: string, options: CommandOptions): CommandDefinition
}
