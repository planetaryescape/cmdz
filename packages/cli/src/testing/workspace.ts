import type { WorkspaceDefinition } from '@cmdz/core/workspace-definition'
import { createTestRenderer } from '@opentui/core/testing'
import { Effect } from 'effect'

import { runWorkspace } from '../workspace-session'

export async function createWorkspace(definitions: readonly WorkspaceDefinition[]) {
  const ui = await createTestRenderer({
    width: 100,
    height: 30,
    kittyKeyboard: false,
    exitOnCtrlC: false,
    exitSignals: [],
  })
  const controller = new AbortController()
  const running = Effect.runPromiseExit(runWorkspace(ui.renderer, definitions), {
    signal: controller.signal,
  })
  return {
    ...ui,
    running,
    async waitFor(text: string) {
      const deadline = performance.now() + 5000
      while (performance.now() < deadline) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        await ui.renderOnce()
        if (ui.captureCharFrame().includes(text)) return
      }
      throw new Error(`Missing ${text}:\n${ui.captureCharFrame()}`)
    },
    async close() {
      controller.abort()
      await running
      ui.renderer.destroy()
    },
  }
}

export const probe: WorkspaceDefinition = {
  name: 'Probe',
  title: 'Probe',
  command: `bun run ${import.meta.dir}/input-probe.ts`,
  cwd: process.cwd(),
  env: {},
  autostart: true,
}
