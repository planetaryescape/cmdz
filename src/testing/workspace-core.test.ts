import { expect, test } from 'bun:test'

import { Effect } from 'effect'

import type { ProcessDefinition } from '../config'
import { makeWorkspaceCore, type WorkspaceCore, type WorkspaceSnapshot } from '../workspace-core'

class FakeProcess {
  readonly input: Uint8Array[] = []
  readonly output: Uint8Array[] = []
  columns = 80
  rows = 24
  active = true

  constructor(
    readonly name: string,
    readonly run: number,
  ) {}

  write(bytes: Uint8Array) {
    this.input.push(bytes)
  }

  emit(bytes: Uint8Array) {
    this.output.push(bytes)
  }

  resize(columns: number, rows: number) {
    this.columns = columns
    this.rows = rows
  }

  stop() {
    this.active = false
  }
}

class FakeWorkspace {
  readonly processes = new Map<string, FakeProcess>()

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
    const { core, processes } = this
    return Effect.gen(function* () {
      const starting = yield* core.dispatch({ type: 'start', name })
      const pane = findPane(starting, name)
      const process = registerProcess(processes, name, pane.run)
      return {
        process,
        snapshot: yield* core.dispatch({ type: 'running', name, run: pane.run }),
      }
    })
  }

  failStart(name: string) {
    const { core, processes } = this
    return Effect.gen(function* () {
      const starting = yield* core.dispatch({ type: 'start', name })
      const pane = findPane(starting, name)
      const process = registerProcess(processes, name, pane.run)
      process.stop()
      return yield* core.dispatch({ type: 'fail', name, run: pane.run })
    })
  }

  exit(name: string, run: number, code: number) {
    const { core, processes } = this
    return Effect.gen(function* () {
      const snapshot = yield* core.dispatch({ type: 'exit', name, run, code })
      processes.get(processKey(name, run))?.stop()
      return snapshot
    })
  }

  focus(name: string) {
    const { core } = this
    return Effect.gen(function* () {
      yield* core.dispatch({ type: 'select', name })
      return yield* core.dispatch({ type: 'input', value: true })
    })
  }

  write(name: string, bytes: Uint8Array) {
    const { core, processes } = this
    return Effect.gen(function* () {
      const snapshot = yield* core.snapshot
      const pane = findPane(snapshot, name)
      if (snapshot.selected !== name || !snapshot.input || pane.status !== 'running')
        throw new Error(`Pane is not accepting input: ${name}`)
      findProcess(processes, name, pane.run).write(bytes)
    })
  }

  emit(name: string, bytes: Uint8Array) {
    const { core, processes } = this
    return Effect.gen(function* () {
      const snapshot = yield* core.snapshot
      const pane = findPane(snapshot, name)
      findProcess(processes, name, pane.run).emit(bytes)
    })
  }

  resize(name: string, columns: number, rows: number) {
    const { core, processes } = this
    return Effect.gen(function* () {
      const snapshot = yield* core.snapshot
      const pane = findPane(snapshot, name)
      findProcess(processes, name, pane.run).resize(columns, rows)
    })
  }

  stop(name: string) {
    const { core, processes } = this
    return Effect.gen(function* () {
      const stopping = yield* core.dispatch({ type: 'stop', name })
      const pane = findPane(stopping, name)
      if (pane.status !== 'stopping') return stopping
      findProcess(processes, name, pane.run).stop()
      return yield* core.dispatch({ type: 'stopped', name, run: pane.run })
    })
  }

  restart(name: string) {
    const stop = this.stop(name)
    const start = this.start(name)
    return Effect.gen(function* () {
      const stopped = yield* stop
      const started = yield* start
      return { stopped, ...started }
    })
  }

  shutdown() {
    const { core } = this
    const stop = (name: string) => this.stop(name)
    return Effect.gen(function* () {
      const snapshot = yield* core.snapshot
      for (const pane of snapshot.panes)
        if (pane.status === 'starting' || pane.status === 'running') yield* stop(pane.name)
      return yield* core.snapshot
    })
  }

  private process(name: string, run: number) {
    return findProcess(this.processes, name, run)
  }
}

const definition = (name: string, autostart: boolean): ProcessDefinition => ({
  name,
  title: name,
  command: name.toLowerCase(),
  cwd: '/',
  env: {},
  autostart,
})

function findPane(snapshot: WorkspaceSnapshot, name: string) {
  const pane = snapshot.panes.find((candidate) => candidate.name === name)
  if (!pane) throw new Error(`Unknown pane: ${name}`)
  return pane
}

function processKey(name: string, run: number) {
  return `${name}:${run}`
}

function registerProcess(processes: Map<string, FakeProcess>, name: string, run: number) {
  const key = processKey(name, run)
  if (processes.has(key)) throw new Error(`Process already registered for run: ${key}`)
  const process = new FakeProcess(name, run)
  processes.set(key, process)
  return process
}

function findProcess(processes: Map<string, FakeProcess>, name: string, run: number) {
  const process = processes.get(processKey(name, run))
  if (!process) throw new Error(`Unknown process run: ${name}:${run}`)
  return process
}

test('drives process I/O and dimensions without OpenTUI or an operating-system process', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const workspace = yield* FakeWorkspace.make([definition('Web', false)])
      const running = yield* workspace.start('Web')
      const output = new Uint8Array([0x1b, 0x5b, 0x32, 0x4a])
      const input = new TextEncoder().encode('reload\n')
      yield* workspace.emit('Web', output)
      yield* workspace.focus('Web')
      yield* workspace.write('Web', input)
      yield* workspace.resize('Web', 132, 43)
      const finished = yield* workspace.exit('Web', running.process.run, 0)
      return { process: running.process, finished, input, output }
    }),
  )

  expect(findPane(result.finished, 'Web').status).toBe('succeeded')
  expect(result.finished.input).toBe(false)
  expect(result.process.output).toEqual([result.output])
  expect(result.process.input).toEqual([result.input])
  expect([result.process.columns, result.process.rows]).toEqual([132, 43])
  expect(result.process.active).toBe(false)
})

test('reports a process startup failure', async () => {
  const snapshot = await Effect.runPromise(
    Effect.gen(function* () {
      const workspace = yield* FakeWorkspace.make([definition('Web', false)])
      return yield* workspace.failStart('Web')
    }),
  )

  expect(findPane(snapshot, 'Web').status).toBe('failed')
})

test('stops and restarts with a fresh run while rejecting stale events', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const workspace = yield* FakeWorkspace.make([definition('Web', false)])
      const first = yield* workspace.start('Web')
      yield* workspace.emit('Web', new TextEncoder().encode('old run'))
      const restarted = yield* workspace.restart('Web')
      yield* workspace.emit('Web', new TextEncoder().encode('new run'))
      const afterUnknownExit = yield* workspace.exit('Web', 0, 9)
      const afterStaleExit = yield* workspace.exit('Web', first.process.run, 9)
      return { first: first.process, restarted, afterUnknownExit, afterStaleExit }
    }),
  )

  expect(findPane(result.restarted.stopped, 'Web').status).toBe('stopped')
  expect(result.first.active).toBe(false)
  expect(result.restarted.process.run).toBe(result.first.run + 1)
  expect(result.restarted.process.output).toEqual([new TextEncoder().encode('new run')])
  expect(findPane(result.afterUnknownExit, 'Web')).toEqual(
    findPane(result.restarted.snapshot, 'Web'),
  )
  expect(findPane(result.afterStaleExit, 'Web')).toEqual(findPane(result.restarted.snapshot, 'Web'))
})

test('rejects duplicate registration without replacing the active process', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const workspace = yield* FakeWorkspace.make([definition('Web', false)])
      const first = yield* workspace.start('Web')
      const duplicate = yield* Effect.exit(workspace.start('Web'))
      return { duplicate, first: first.process, processes: workspace.processes }
    }),
  )

  expect(result.duplicate._tag).toBe('Failure')
  expect(result.processes.size).toBe(1)
  expect(result.processes.get(processKey('Web', result.first.run))).toBe(result.first)
  expect(result.first.active).toBe(true)
})

test('shuts down every active process and leaves idle processes untouched', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const workspace = yield* FakeWorkspace.make([
        definition('Web', true),
        definition('Worker', true),
        definition('Optional', false),
      ])
      yield* workspace.focus('Worker')
      const snapshot = yield* workspace.shutdown()
      return { processes: Array.from(workspace.processes.values()), snapshot }
    }),
  )

  expect(result.snapshot.panes.map(({ name, status }) => [name, status])).toEqual([
    ['Web', 'stopped'],
    ['Worker', 'stopped'],
    ['Optional', 'idle'],
  ])
  expect(result.snapshot.input).toBe(false)
  expect(result.processes.every((process) => !process.active)).toBe(true)
})
