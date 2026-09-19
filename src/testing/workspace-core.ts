import { Effect } from 'effect'

import type { ProcessDefinition } from '../config'
import { makeWorkspaceCore, type WorkspaceCore, type WorkspaceSnapshot } from '../workspace-core'

export class FakeWorkspace {
  readonly output = new Map<string, Uint8Array[]>()

  private constructor(readonly core: WorkspaceCore) {}

  static make(definitions: readonly ProcessDefinition[]) {
    return Effect.map(makeWorkspaceCore(definitions), (core) => new FakeWorkspace(core))
  }

  snapshot() {
    return this.core.snapshot
  }

  start(name: string) {
    const { core } = this
    return Effect.gen(function* () {
      const starting = yield* core.dispatch({ type: 'start', name })
      const pane = starting.panes.find((candidate) => candidate.name === name)
      if (!pane) return starting
      return yield* core.dispatch({ type: 'running', name, run: pane.run })
    })
  }

  stop(name: string) {
    const { core } = this
    return Effect.gen(function* () {
      const stopping = yield* core.dispatch({ type: 'stop', name })
      const pane = stopping.panes.find((candidate) => candidate.name === name)
      if (!pane) return stopping
      return yield* core.dispatch({ type: 'stopped', name, run: pane.run })
    })
  }

  exit(name: string, code: number) {
    const { core } = this
    return Effect.gen(function* () {
      const snapshot = yield* core.snapshot
      const pane = snapshot.panes.find((candidate) => candidate.name === name)
      if (!pane) return snapshot
      return yield* core.dispatch({ type: 'exit', name, run: pane.run, code })
    })
  }

  write(name: string, output: Uint8Array) {
    const writes = this.output.get(name) ?? []
    writes.push(output)
    this.output.set(name, writes)
  }
}

export const pane = (snapshot: WorkspaceSnapshot, name: string) =>
  snapshot.panes.find((candidate) => candidate.name === name)
