import { createTestRenderer } from '@opentui/core/testing'
import { Effect } from 'effect'

import type { ProcessDefinition } from '../config'
import { processWorkspace } from '../process-workspace'

export async function createWorkspace(definitions: readonly ProcessDefinition[]) {
  const ui = await createTestRenderer({
    width: 100,
    height: 30,
    kittyKeyboard: false,
    exitOnCtrlC: false,
    exitSignals: [],
  })
  const controller = new AbortController()
  const running = Effect.runPromiseExit(processWorkspace(ui.renderer, definitions), {
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

export const probe: ProcessDefinition = {
  name: 'Probe',
  title: 'Probe',
  command: 'bun run src/testing/input-probe.ts',
  cwd: process.cwd(),
  env: {},
  autostart: true,
}
