/** A validated command definition consumed by a workspace controller. */
export interface WorkspaceDefinition {
  readonly name: string
  readonly command: string
  readonly cwd: string
  readonly title: string
  readonly env: Readonly<Record<string, string>>
  readonly autostart: boolean
}
