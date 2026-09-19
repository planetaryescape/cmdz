import { expect, test } from 'bun:test'

import { Effect } from 'effect'

import type { ProcessDefinition } from '../config'
import { makeWorkspaceCore, type WorkspaceCore, type WorkspaceSnapshot } from '../workspace-core'

class FakeWorkspace {
  readonly output = new Map<string, Uint8Array[]>()

  private constructor(readonly core: WorkspaceCore) {}

  static make(definitions: readonly ProcessDefinition[]) {
    return Effect.gen(function* () {
      const workspace = new FakeWorkspace(yield* makeWorkspaceCore(definitions))
      for (const definition of definitions)
        if (definition.autostart) yield* workspace.start(definition.name)
      return workspace
    })
  }

  start(name: string) {
    const { core } = this
    return Effect.gen(function* () {
      const starting = yield* core.dispatch({ type: 'start', name })
      const pane = starting.panes.find((candidate) => candidate.name === name)
      if (!pane) throw new Error(`Unknown pane: ${name}`)
      return {
        snapshot: yield* core.dispatch({ type: 'running', name, run: pane.run }),
        run: pane.run,
      }
    })
  }

  exit(name: string, run: number, code: number) {
    const { core } = this
    return Effect.gen(function* () {
      const snapshot = yield* core.snapshot
      const pane = snapshot.panes.find((candidate) => candidate.name === name)
      if (!pane) throw new Error(`Unknown pane: ${name}`)
      return yield* core.dispatch({ type: 'exit', name, run, code })
    })
  }

  write(name: string, output: Uint8Array) {
    const writes = this.output.get(name) ?? []
    writes.push(output)
    this.output.set(name, writes)
  }
}

const pane = (snapshot: WorkspaceSnapshot, name: string) =>
  snapshot.panes.find((candidate) => candidate.name === name)

test('drives a headless command lifecycle without OpenTUI or a child process', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const workspace = yield* FakeWorkspace.make([
        { name: 'Web', title: 'Web', command: 'web', cwd: '/', env: {}, autostart: false },
      ])
      const running = yield* workspace.start('Web')
      workspace.write('Web', new TextEncoder().encode('ready'))
      const finished = yield* workspace.exit('Web', running.run, 0)
      const restarted = yield* workspace.start('Web')
      const failed = yield* workspace.exit('Web', restarted.run, 1)
      return { running, finished, failed, output: workspace.output.get('Web') }
    }),
  )

  expect(pane(result.running.snapshot, 'Web')?.status).toBe('running')
  expect(pane(result.finished, 'Web')?.status).toBe('succeeded')
  expect(pane(result.failed, 'Web')?.status).toBe('failed')
  expect(new TextDecoder().decode(result.output?.[0])).toBe('ready')
})
